import type { DiffFileStatus, DiffGroup } from "./diff-extract.ts";
import type { GroupingMode } from "./llm/grouping.ts";

export type SessionStatus = "open" | "feedback" | "ended";

/**
 * An agent whose waiting command returns on an ended review must be able to tell whether
 * a person looked at all.
 */
export type ReviewCloser = "reviewer" | "agent";

/**
 * Persisted rather than held in memory because a `serve` restart that silently
 * handed sending back would let the reviewer fire at an agent that is still
 * editing. A union on `holder` so the fields that only mean something on one
 * side cannot be read on the other.
 */
export type Turn = ReviewerTurn | AgentTurn;

export interface ReviewerTurn {
  holder: "reviewer";
  at: string;
}

/**
 * `digesting` is the agent's discussion turn: it holds a batch and ends the
 * turn with `reply` (talk) or `work` (change code). `working` is the only phase
 * that lasts: it ends with `publish`, which opens the next round. Required, so
 * no reader has to decide what an agent's turn with no phase would mean.
 */
export interface AgentTurn {
  holder: "agent";
  mode: "digesting" | "working";
  at: string;
  /** The plan `work` declared; only on `working`. */
  note?: string;
  /**
   * HEAD when `work` was declared. A `reply` from `working` is allowed only
   * while HEAD is still this and the tree still matches `tree`: nothing
   * half-written to protect, so talking instead of publishing loses nothing.
   */
  head?: string;
  /**
   * The tree's content hashed when `work` was declared — `git diff HEAD
   * --binary` plus each untracked file's name and bytes: the tree a
   * `reply` from `working` must still match. Absent when git could not be
   * read at `work`, which refuses any reply from `working`.
   */
  tree?: string;
}

/**
 * The batch the agent is digesting — or last digested. Kept after delivery, not
 * dropped: while the agent holds it, every waiting command that re-attaches
 * (`open`, a re-run `reply` or `publish`) is handed the same batch again, which
 * is what makes a waiting command killed mid-delivery safe to re-run. TCP
 * cannot say whether an answer was read, so `acked` is the agent's CLI saying
 * it arrived (`POST /api/session/:key/delivered`); it is how a re-run `reply`
 * is told apart from a new one that happens to say the same words.
 */
export interface Batch {
  /** Minted per delivery and echoed back, so a stale ack confirms nothing. */
  id: string;
  prompts: FeedbackPrompt[];
  at: string;
  acked?: boolean;
}

/**
 * The last command that handed the turn back. A waiting command killed by a
 * harness timeout or a server restart is re-run as-is; the fingerprint is how
 * the server recognises it and waits again instead of posting twice.
 */
export interface Handback {
  verb: "reply" | "publish";
  fingerprint: string;
  /** The batch that was current when it was sent; absent before any delivery. */
  batch?: string;
}

export type AnnotationSide = "old" | "new";

export interface LineAnchor {
  side: AnnotationSide;
  line_start: number;
  line_end: number;
  /**
   * Selection bounds on `line_start`/`line_end`, 1-based inclusive, in UTF-16
   * code units of the file's line (no `+`/`-` marker; astral chars span two —
   * what the browser measured). Each end stands alone; absent means that
   * boundary line was taken whole, so full-line selections carry no columns
   * and older readers keep working.
   */
  col_start?: number;
  col_end?: number;
}

/**
 * Flattened into the carrier, as the wire format spells it; the union makes half
 * an anchor — which locates nothing — unrepresentable.
 */
export type AnchorFields =
  | LineAnchor
  | {
      side?: undefined;
      line_start?: undefined;
      line_end?: undefined;
      col_start?: undefined;
      col_end?: undefined;
    };

export type AnnotationPrompt = {
  type: "annotation";
  /**
   * The thread this item opens (`t1`, `t2`…), minted by the server on
   * acceptance: a queued prompt has none — `parsePrompt` strips whatever a
   * client claims. Sessions from before 3.0 carry `evt_…` ids here, which still
   * name their thread; pre-id prompts never get one.
   */
  id?: string;
  file: string;
  group: string;
  selected_text: string;
  comment: string;
} & AnchorFields;

/** A general item: a thread with no anchor. */
export interface MessagePrompt {
  type: "message";
  /** The thread it opens; minted like an annotation's. Absent before 3.0. */
  id?: string;
  comment: string;
  /** Written by 2.x's `ask` verb; read so old conversations still render. */
  kind?: "question";
}

/**
 * Words inside a thread, from either side. The agent's `--to main` posts to
 * `main`, the one thread no reviewer item opened.
 */
export interface ReplyPrompt {
  type: "reply";
  thread: string;
  comment: string;
}

/**
 * The reviewer's resolve toggle. It sends nothing by itself; it travels with
 * the next Send. On a change request it means "I agree with what you last
 * said", never "withdrawn".
 */
export interface ResolvePrompt {
  type: "resolve";
  thread: string;
  resolved: boolean;
}

export type FeedbackPrompt = AnnotationPrompt | MessagePrompt | ReplyPrompt | ResolvePrompt;

export interface ConversationEntry {
  role: "reviewer" | "agent";
  at: string;
  /**
   * Round open when this was said (`SessionRound.index`). Absent on pre-stamp
   * entries, placed by timestamp instead — see `src/browser/conversation-rounds.ts`.
   */
  roundIndex?: number;
  prompts: FeedbackPrompt[];
}

/** Named apart from the full round because the conversation panel takes only this much. */
export interface RoundMark {
  index: number;
  at: string;
}

export interface RoundFile {
  path: string;
  /**
   * Rounds recorded while git was still asked for copies hold a copy's source
   * here under `modified`; only a rename's is followed through the rounds
   * (`renamedFrom`).
   */
  previousPath?: string;
  status: DiffFileStatus;
  /**
   * New-side blob sha as the round's patch abbreviated it; null when the patch
   * named none (binary, 100%-identical rename). Widths vary between rounds, so
   * shas are compared by `src/rounds/history.ts`, never with `===`.
   */
  blob: string | null;
}

/**
 * `open`/`publish` append and close the round they displace, `end` closes the newest;
 * closing records the approved ticks, and a new grouping resets them, so this is
 * the only place that knowledge survives.
 */
export interface SessionRound extends RoundMark {
  /** Ledger id; absent pre-outcomes. */
  round?: string;
  baseCommit?: string;
  headCommit?: string;
  /**
   * Per round so a later round can say something else without touching what was
   * approved. Absent pre-intents.
   */
  intents?: string[];
  commits?: string[];
  /**
   * Absent (pre-recording) reads as `llm`. Recorded because a degraded round
   * (`fallback`/`skipped` = one `All Changes` group) is not a reading order
   * `publish` may hand back to the next round.
   */
  grouping?: GroupingMode;
  files: RoundFile[];
  /**
   * Empty while open, and empty forever on rounds whose approvals were lost
   * before opening a round closed displaced rounds. Older rounds lack the field entirely
   * and read as closing on nothing; see `parseSession`.
   */
  approvedAtEnd: string[];
}

export interface SessionRecord {
  key: string;
  repoRoot: string;
  branch: string;
  base: string;
  /** Absent on sessions written before whole-file context existed. */
  baseCommit?: string;
  headCommit?: string;
  status: SessionStatus;
  /**
   * Never optional to a reader: a session file written before turns existed
   * opens with the reviewer holding it — see `parseSession`.
   */
  turn: Turn;
  /**
   * Set when `status` becomes `ended`, dropped on reopen. Absent on older
   * sessions reads as "nobody wrote it down", not as either party.
   */
  endedBy?: ReviewCloser;
  createdAt: string;
  updatedAt: string;
  /**
   * In display order. Never optional: a file missing it, or a group without
   * `files`, is rejected as corrupt — see `parseSession`.
   */
  groups: DiffGroup[];
  conversation: ConversationEntry[];
  /** Sent by the reviewer, not yet delivered to an agent. */
  pending: FeedbackPrompt[];
  /** Absent until the first delivery. */
  batch?: Batch;
  lastHandback?: Handback;
  /** Reset whenever `open`/`publish` re-groups. */
  approved: string[];
  /** Ledger id of the round on show; absent on sessions from before the ledger existed. */
  round?: string;
  /**
   * Oldest first. `src/rounds/history.ts` derives a file's whole past from it,
   * so it is never optional: absent is rejected, not "no history".
   */
  rounds: SessionRound[];
}
