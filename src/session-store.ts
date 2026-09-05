import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DiffFileStatus, DiffGroup } from "./diff-extract.ts";
import type { GroupingMode } from "./llm/grouping.ts";
import { ReviewError } from "./errors.ts";
import { sessionFilePath, sessionsDirPath } from "./paths.ts";

export type SessionStatus = "open" | "feedback" | "ended";

/**
 * Who closed the review: reviewer `Send & End` or agent `lightspeed end`. An
 * agent polling an ended review must be able to tell whether a person looked at all.
 */
export type ReviewCloser = "reviewer" | "agent";

/** Which version of the file the annotated lines belong to. */
export type AnnotationSide = "old" | "new";

/** The line range a selection covers in one version of a file. */
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
 * An anchor flattened into its carrier, as the wire format spells it. The union
 * makes half an anchor — which locates nothing — unrepresentable.
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

/** A reviewer annotation anchored to the diff text it was selected from. */
export type AnnotationPrompt = {
  type: "annotation";
  /**
   * Server-minted id this comment goes by everywhere (poll output, declarations,
   * ledger). Minted on acceptance: a queued prompt has none — `parsePrompt`
   * strips whatever a client claims — and pre-id prompts never get one, which
   * reads as "unknown", not as any particular comment.
   */
  id?: string;
  file: string;
  group: string;
  selected_text: string;
  comment: string;
} & AnchorFields;

/** A free-form message: a reviewer's general comment or an agent reply. */
export interface MessagePrompt {
  type: "message";
  comment: string;
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

/**
 * Which round, and when it opened — all a reader needs to place something in the
 * review's history. Named apart from the full round because the conversation
 * panel takes only this much.
 */
export interface RoundMark {
  index: number;
  at: string;
}

/** One file of the review as it stood in one round. */
export interface RoundFile {
  path: string;
  /** Where a rename came from, under the name that round's diff used. */
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
 * One `start` … `end` cycle. `start` appends and closes the round it displaces,
 * `end` closes the newest; closing records the approved ticks. A new grouping
 * resets ticks, so this is the only place that knowledge survives.
 */
export interface SessionRound extends RoundMark {
  /** Ledger id tying ledger records back to this round. Absent pre-outcomes. */
  round?: string;
  baseCommit?: string;
  headCommit?: string;
  /**
   * Why the branch exists, as stated at round open. Per round so a later round
   * can say something else without touching what was approved. Absent pre-intents.
   */
  intents?: string[];
  /** Subjects of the commits the branch added when the round opened. */
  commits?: string[];
  /**
   * How the grouping was arrived at; absent (pre-recording) reads as `llm`.
   * Recorded because a degraded round (`fallback`/`skipped` = one `All Changes`
   * group) is not a reading order `start` may hand back to the next round.
   */
  grouping?: GroupingMode;
  files: RoundFile[];
  /**
   * Paths approved at close; empty while open, and empty forever on rounds whose
   * approvals were lost before `start` closed displaced rounds. Older rounds
   * lack the field entirely and read as closing on nothing; see `parseSession`.
   */
  approvedAtEnd: string[];
}

export interface SessionRecord {
  key: string;
  repoRoot: string;
  branch: string;
  base: string;
  /**
   * The commits this round's diff was taken between, when the CLI could resolve
   * them. Absent on sessions written before whole-file context existed.
   */
  baseCommit?: string;
  headCommit?: string;
  status: SessionStatus;
  /**
   * Set when `status` becomes `ended`, dropped on reopen. Absent on older
   * sessions reads as "nobody wrote it down", not as either party.
   */
  endedBy?: ReviewCloser;
  createdAt: string;
  updatedAt: string;
  /**
   * Latest grouping, in display order. Never optional: a file missing it, or a
   * group without `files`, is rejected as corrupt — see `parseSession`.
   */
  groups: DiffGroup[];
  /** Everything already delivered, oldest first. */
  conversation: ConversationEntry[];
  /** Queued by the browser, not yet handed to a `poll`. */
  pending: FeedbackPrompt[];
  /** Paths ticked `approved`; reset whenever `start` re-groups. */
  approved: string[];
  /**
   * Ledger id of the round on show; every ledger record of the round anchors to
   * it. Absent on sessions from before the ledger existed.
   */
  round?: string;
  /**
   * Every round, oldest first. `src/rounds/history.ts` derives a file's whole
   * past from it, so it is never optional: absent is rejected, not "no history".
   */
  rounds: SessionRound[];
  /**
   * What the agent said each comment led to, keyed by `AnnotationPrompt.id`;
   * newest declaration wins, which makes redeclaring idempotent. On the session,
   * not just the ledger: replay reads from here and the ledger may be off.
   * Absent reads as "nothing declared", never "nothing changed".
   */
  declarations?: Record<string, DeclaredAnswer>;
}

/** One comment's declared answer: the note, the files it led to, and when. */
export interface DeclaredAnswer {
  /** The agent's per-comment answer; absent when only files were declared. */
  note?: string;
  /** Paths the comment led to changes in; empty for a question or a decision. */
  files: string[];
  at: string;
}

/**
 * One JSON file per session. Dumb persistence: timestamps and status transitions
 * belong to the caller, so tests stay deterministic. Only hole-causing fields are
 * checked; retired keys (e.g. `journeys`) are neither errors nor stripped.
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
  // written before tiers existed opens as `study`: the review it belongs to was
  // read chapter by chapter, and the safe direction for a missing answer is the
  // one that asks for the reading rather than the one that waves it through.
  return {
    ...parsed,
    groups: parsed.groups.map((group) => ({ ...group, tier: group.tier ?? "study" })),
    rounds: parsed.rounds.map((round) => ({ ...round, approvedAtEnd: round.approvedAtEnd ?? [] })),
  };
}

/**
 * A group without `files` is a hole every reader falls into. Checked here, not
 * at the call site that noticed (`start`): a TypeError out of a session file is
 * a corrupt session however spelt, with the same delete-the-file answer.
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
      `Delete \`sessions/${key}.json\` in your state directory and re-run \`lightspeed start <branch> [base]\``,
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
