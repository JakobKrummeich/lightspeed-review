import type { DiffFile, DiffGroup } from "../diff-extract.ts";
import type { GroupingMode } from "../llm/grouping.ts";
import { readBlobs } from "../ledger/write.ts";
import { carriedApproval } from "./history.ts";
import type {
  ConversationEntry,
  DeclaredAnswer,
  FeedbackPrompt,
  ReviewCloser,
  RoundFile,
  SessionRecord,
  SessionRound,
  SessionStatus,
} from "../session-store.ts";

/** What `start` posts: the diff of one round, as the CLI resolved it. */
export interface CreateSessionRequest {
  repoRoot: string;
  branch: string;
  base: string;
  baseCommit?: string;
  headCommit?: string;
  groups: DiffGroup[];
  /**
   * How `groups` was arrived at. Absent from an older client's body, which is
   * read as the model's work — see `SessionRound.grouping`.
   */
  grouping?: GroupingMode;
  /** Why the branch exists, in the order the agent gave it. */
  intents: string[];
  /** Subjects of the commits the branch adds, newest first. */
  commits: string[];
  /** The reviewer asked for another round, so an ended review opens again. */
  reopen?: boolean;
}

/** What only the server knows when a round opens: its ids and the clock. */
export interface RoundStamp {
  key: string;
  /** Ledger id of the round, which every record of it is anchored to. */
  round: string;
  now: string;
}

/**
 * The session after a `start`: the new grouping on what the previous round left.
 * An ended session stays ended — only the reviewer reopens — and a re-group
 * withdraws approval from every file a blob sha cannot vouch for; the
 * conversation is the reviewer's history and must survive.
 */
export function nextSessionRecord(
  existing: SessionRecord | undefined,
  payload: CreateSessionRequest,
  stamp: RoundStamp,
): SessionRecord {
  // Outgoing round closed here, where every path into a new round runs:
  // `approvedAtEnd` is the only place ticks survive a re-group.
  const previous = existing === undefined ? [] : withClosedRound(existing).rounds;
  const rounds = [...previous, openRound(previous, payload, stamp)];
  return {
    key: stamp.key,
    repoRoot: payload.repoRoot,
    branch: payload.branch,
    base: payload.base,
    baseCommit: payload.baseCommit,
    headCommit: payload.headCommit,
    ...carriedOver(existing, stamp.now, payload.reopen === true),
    updatedAt: stamp.now,
    groups: payload.groups,
    // Re-grouping withdraws approval except where a blob sha proves the file
    // unmoved: the reviewer already read this exact text.
    approved: carriedApproval(rounds),
    round: stamp.round,
    rounds,
  };
}

/** Everything a new grouping inherits rather than resets. */
function carriedOver(
  existing: SessionRecord | undefined,
  now: string,
  reopen: boolean,
): {
  status: SessionStatus;
  endedBy?: ReviewCloser;
  createdAt: string;
  conversation: ConversationEntry[];
  pending: FeedbackPrompt[];
  declarations?: Record<string, DeclaredAnswer>;
} {
  if (existing === undefined) {
    return { status: "open", createdAt: now, conversation: [], pending: [] };
  }
  const { createdAt, conversation, pending, declarations } = existing;
  // Reopening is the reviewer's word relayed by the agent, so it is the one
  // thing that turns an ended review back into work.
  const status = reopen ? "open" : existing.status;
  // A reopened review has not ended, so it carries no record of who ended it;
  // one that stays ended keeps the party that closed it.
  const endedBy = reopen ? undefined : existing.endedBy;
  return {
    status,
    ...(endedBy === undefined ? {} : { endedBy }),
    createdAt,
    conversation,
    pending,
    // Carried with the conversation that holds their comments: the agent's word
    // does not expire on re-group, and the replay reads them right after a `start`.
    ...(declarations === undefined ? {} : { declarations }),
  };
}

/**
 * The round `start` opens: what the diff showed, before anything was approved.
 * Blob shas come from the patches, so a later round can tell an edited file
 * from an untouched one without going back to git.
 */
function openRound(
  previous: SessionRound[],
  payload: CreateSessionRequest,
  stamp: RoundStamp,
): SessionRound {
  return {
    index: previous.length,
    round: stamp.round,
    at: stamp.now,
    ...(payload.baseCommit === undefined ? {} : { baseCommit: payload.baseCommit }),
    ...(payload.headCommit === undefined ? {} : { headCommit: payload.headCommit }),
    intents: payload.intents,
    commits: payload.commits,
    ...(payload.grouping === undefined ? {} : { grouping: payload.grouping }),
    files: roundFiles(payload.groups.flatMap((group) => group.files)),
    approvedAtEnd: [],
  };
}

/** The diff as a round records it. */
function roundFiles(files: DiffFile[]): RoundFile[] {
  return files.map((file) => ({
    path: file.path,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    status: file.status,
    blob: readBlobs(file.diff).new,
  }));
}

/**
 * What this review is for, as of the round on screen. Rounds older than intents
 * have none, which reads as a review that never said — not as an empty reason.
 */
export function currentIntents(session: SessionRecord): string[] {
  return session.rounds.at(-1)?.intents ?? [];
}

/** The branch's own commit subjects, as of the round on screen. */
export function currentCommits(session: SessionRecord): string[] {
  return session.rounds.at(-1)?.commits ?? [];
}

/**
 * No rounds, or a round from before this was recorded, read as `llm`: the field
 * catches a round known to have degraded, not every round that cannot prove it didn't.
 */
export function currentGroupingMode(session: SessionRecord): GroupingMode {
  return session.rounds.at(-1)?.grouping ?? "llm";
}

/**
 * Newest round closed: `approvedAtEnd` takes the live approved set. `end` closes
 * where it stands so the ledger says what was approved without another `start`;
 * opening a round closes the one it displaces. Re-closing writes the same paths —
 * idempotent wherever a round stops being current.
 */
export function withClosedRound(session: SessionRecord): SessionRecord {
  const rounds = session.rounds;
  const current = rounds.at(-1);
  if (current === undefined) return session;
  return {
    ...session,
    rounds: [...rounds.slice(0, -1), { ...current, approvedAtEnd: session.approved }],
  };
}
