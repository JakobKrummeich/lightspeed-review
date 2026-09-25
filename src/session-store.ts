import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiffFileStatus, DiffGroup } from "./diff-extract.ts";
import { trailSweeps } from "./group-tier.ts";
import type { GroupingMode } from "./llm/grouping.ts";
import { ReviewError } from "./errors.ts";
import { startCall } from "./start-call.ts";
import { sessionFilePath, sessionsDirPath } from "./paths.ts";

export type SessionStatus = "open" | "feedback" | "ended";

/**
 * An agent whose `wait` returns on an ended review must be able to tell whether
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

export interface AgentTurn {
  holder: "agent";
  /**
   * Presentational only: `reading` and `working` gate identically. Required, so
   * no reader has to decide what an agent's turn with no mode would mean.
   */
  mode: "reading" | "working";
  at: string;
  note?: string;
}

/**
 * TCP cannot say whether an answer was read: the bytes reach the OS whether the
 * client is reading or already gone, so the only witness that a delivery landed
 * is the agent saying so (`POST /api/session/:key/delivered`). Until it does,
 * the batch is held here and the next poll puts it back — persisted, not kept
 * in memory, because a `serve` restart in that window would otherwise be the
 * one way feedback is lost for good.
 */
export interface Delivery {
  /** Minted per handover and echoed back, so a stale ack confirms nothing. */
  id: string;
  /** Exactly what was drained, in written order, to put back at the head. */
  prompts: FeedbackPrompt[];
  at: string;
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
   * Server-minted on acceptance: a queued prompt has none — `parsePrompt` strips
   * whatever a client claims — and pre-id prompts never get one, which reads as
   * "unknown", not as any particular comment.
   */
  id?: string;
  file: string;
  group: string;
  selected_text: string;
  comment: string;
} & AnchorFields;

export interface MessagePrompt {
  type: "message";
  comment: string;
  /**
   * Set by `lightspeed ask`, so the panel draws an answer box under it. Absent
   * is an ordinary message, never a question nobody answered.
   */
  kind?: "question";
}

export type FeedbackPrompt = AnnotationPrompt | MessagePrompt;

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
 * `start` appends and closes the round it displaces, `end` closes the newest;
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
   * `start` may hand back to the next round.
   */
  grouping?: GroupingMode;
  files: RoundFile[];
  /**
   * Empty while open, and empty forever on rounds whose approvals were lost
   * before `start` closed displaced rounds. Older rounds lack the field entirely
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
  pending: FeedbackPrompt[];
  /**
   * Absent is the steady state: nothing is in flight, and every prompt the
   * review owes the agent is in `pending`.
   */
  delivering?: Delivery;
  /** Reset whenever `start` re-groups. */
  approved: string[];
  /** Ledger id of the round on show; absent on sessions from before the ledger existed. */
  round?: string;
  /**
   * Oldest first. `src/rounds/history.ts` derives a file's whole past from it,
   * so it is never optional: absent is rejected, not "no history".
   */
  rounds: SessionRound[];
  /**
   * The round, as `round:` prints it, whose full `help[]` an answer has already
   * carried (see `budgetHelp`). Absent reads as "not yet told", the safe
   * direction: the cost of being wrong is a repeated help block, not a lost move.
   */
  helpShownRound?: number;
  /**
   * Keyed by `AnnotationPrompt.id`. On the session, not just the ledger: replay
   * reads from here and the ledger may be off. Absent reads as "nothing
   * declared", never "nothing changed".
   */
  declarations?: Record<string, DeclaredAnswer>;
}

export interface DeclaredAnswer {
  note?: string;
  files: string[];
  at: string;
}

/**
 * Timestamps and status transitions belong to the caller, so tests stay
 * deterministic. Only hole-causing fields are checked; retired keys (e.g.
 * `journeys`) are neither errors nor stripped.
 */
function parseSession(contents: string, key: string): SessionRecord {
  let parsed: SessionRecord;
  try {
    parsed = JSON.parse(contents) as SessionRecord;
  } catch (error) {
    throw sessionCorrupt(key, `session ${key} is not readable JSON`, (error as Error).message);
  }
  if (!Array.isArray(parsed.rounds)) {
    throw sessionCorrupt(
      key,
      `session ${key} has no rounds`,
      "it was written before rounds were recorded, so nothing can be said about what was reviewed",
    );
  }
  if (!Array.isArray(parsed.groups) || !parsed.groups.every(readableGroup)) {
    throw sessionCorrupt(
      key,
      `session ${key} has no readable grouping`,
      "its `groups` is missing, or a group in it has no `files`, so there is no review to show",
    );
  }
  // `approvedAtEnd` postdates `rounds`, and `tier` postdates `groups`; both are
  // filled in here so no reader has to ask whether the field is there. A group
  // written before tiers existed opens as `study`: the safe direction for a
  // missing answer is the one that asks for the reading rather than the one
  // that waves it through. Ordered after that default is filled in, never
  // before, since an untiered chapter is one to study and belongs above the bulk.
  return {
    ...parsed,
    // A session from before turns existed opens with the reviewer holding it:
    // a lock nobody can lift is a review nobody can finish. Stamped at the last
    // write, the only moment the file can vouch for.
    turn: parsed.turn ?? { holder: "reviewer", at: parsed.updatedAt },
    groups: trailSweeps(parsed.groups.map((group) => ({ ...group, tier: group.tier ?? "study" }))),
    rounds: parsed.rounds.map((round) => ({ ...round, approvedAtEnd: round.approvedAtEnd ?? [] })),
  };
}

/**
 * Checked here, not at the call site that noticed (`start`): a TypeError out of
 * a session file is a corrupt session however spelt, with the same
 * delete-the-file answer.
 */
function readableGroup(group: unknown): boolean {
  return typeof group === "object" && group !== null && Array.isArray((group as DiffGroup).files);
}

function sessionCorrupt(key: string, message: string, detail: string): ReviewError {
  return new ReviewError({
    code: "session_corrupt",
    message,
    detail,
    suggestions: [
      `Delete \`sessions/${key}.json\` in your state directory and re-run \`${startCall("<branch> [base]")}\``,
    ],
  });
}

export class SessionStore {
  readonly #stateDir: string;
  readonly #directory: string;

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
    this.#directory = sessionsDirPath(stateDir);
  }

  get(key: string): SessionRecord | undefined {
    let contents: string;
    try {
      contents = readFileSync(sessionFilePath(this.#stateDir, key), "utf8");
    } catch {
      return undefined;
    }
    return parseSession(contents, key);
  }

  list(): SessionRecord[] {
    let entries: string[];
    try {
      entries = readdirSync(this.#directory);
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) =>
        parseSession(readFileSync(join(this.#directory, entry), "utf8"), entry.slice(0, -5)),
      );
  }

  save(record: SessionRecord): void {
    mkdirSync(this.#directory, { recursive: true });
    const target = sessionFilePath(this.#stateDir, record.key);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  }

  remove(key: string): void {
    rmSync(sessionFilePath(this.#stateDir, key), { force: true });
  }
}
