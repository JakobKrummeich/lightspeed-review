import type { DiffFile, DiffFileStatus } from "../diff-extract.ts";
import { diffStats } from "../diff-extract.ts";
import type { AnnotationPrompt, FeedbackPrompt, SessionRecord } from "../session-store.ts";
import {
  carriedApproval,
  firstSeenRound,
  roundApproval,
  type Approval,
} from "../rounds/history.ts";
import { sliceContext } from "./context.ts";
import {
  anchorOf,
  buildAgentReplyRecord,
  buildAnnotationRecord,
  buildMessageRecord,
  buildRoundEndRecord,
  buildRoundFileRecord,
  buildRoundRecord,
  type AnnotationSide,
  type IdSource,
  type LedgerRecord,
  type RepoRef,
} from "./records.ts";
import type { LedgerStore } from "./store.ts";

/**
 * Pure: ids and timestamps come from the caller's clock and id source only, so
 * nothing here keeps state between calls.
 */
interface WriteContext {
  repo: RepoRef;
  now: string;
  nextId: IdSource;
}

export interface RoundInput extends WriteContext {
  round: string;
  session: SessionRecord;
}

/**
 * Undefined when git has no such version. Injected so composing records stays
 * pure and testable — the server passes a reader restricted to this session's
 * own files.
 */
export type ReadSideFile = (path: string, side: AnnotationSide) => string | undefined;

export interface FeedbackInput extends WriteContext {
  session: SessionRecord;
  prompts: FeedbackPrompt[];
  readFile: ReadSideFile;
}

export interface ReplyInput extends WriteContext {
  session: SessionRecord;
  comment: string;
}

export interface EndInput extends WriteContext {
  session: SessionRecord;
}

export interface LedgerWriteResult {
  status: "on" | "off" | "degraded";
  written: number;
  failed: number;
  path?: string;
  reason?: string;
}

/**
 * The single place ledger failures are swallowed and counted. A full disk, a
 * read-only state directory or an unserialisable record degrades the report and
 * never touches the review itself.
 */
export function recordSafely(
  ledger: LedgerStore | undefined,
  records: LedgerRecord[],
): LedgerWriteResult {
  if (ledger === undefined) return { status: "off", written: 0, failed: 0 };
  let written = 0;
  let failed = 0;
  let reason: string | undefined;
  for (const record of records) {
    const result = ledger.append(record);
    if (result.ok) written += 1;
    else {
      failed += 1;
      reason ??= result.reason;
    }
  }
  if (failed === 0) return { status: "on", written, failed, path: ledger.path };
  return { status: "degraded", written, failed, path: ledger.path, reason: reason ?? "unknown" };
}

export function roundRecords(input: RoundInput): LedgerRecord[] {
  const { round, session, repo, now } = input;
  const approval = roundApproval(session.rounds, session.approved);
  const files = session.groups.flatMap((group) =>
    group.files.map((file) => ({ file, group: group.name })),
  );
  const head = buildRoundRecord({
    id: input.nextId("evt", now),
    at: now,
    round,
    repo,
    branch: session.branch,
    base: session.base,
    ...commitFields(session),
    stats: diffStats(files.map((entry) => entry.file)),
    groups: session.groups.map((group) => group.name),
  });
  // A binary file has no patch and nothing to comment on, so it gets no record.
  const perFile = files
    .filter((entry) => entry.file.status !== "binary")
    .map((entry) => roundFileRecord(input, entry.file, entry.group, approval[entry.file.path]));
  return [head, ...perFile];
}

function roundFileRecord(
  input: RoundInput,
  file: DiffFile,
  group: string,
  approval: Approval | undefined,
): LedgerRecord {
  const blobs = readBlobs(file.diff);
  // Every grouped file is in this round's own `files`, so `firstSeenRound` always
  // answers and this stands only for the impossible.
  const currentRound = input.session.rounds.at(-1)?.index ?? 0;
  return buildRoundFileRecord({
    id: input.nextId("evt", input.now),
    at: input.now,
    round: input.round,
    repo: input.repo,
    file: file.path,
    previous_path: file.previousPath ?? null,
    file_status: file.status,
    group,
    blob_new: blobs.new,
    blob_old: blobs.old,
    patch: file.diff,
    // A path the round does not list has no history: nobody can have approved it.
    approval: approval ?? "unapproved",
    first_seen_round: firstSeenRound(input.session.rounds, file.path) ?? currentRound,
  });
}

/**
 * A resolve toggle carries no words, so it has no record: the ledger is what
 * was said. A reply in a thread is a message like any other.
 */
export function feedbackRecords(input: FeedbackInput): LedgerRecord[] {
  return input.prompts.flatMap((prompt) => {
    if (prompt.type === "resolve") return [];
    return [
      prompt.type === "annotation" ? annotationRecord(input, prompt) : messageRecord(input, prompt),
    ];
  });
}

function annotationRecord(input: FeedbackInput, prompt: AnnotationPrompt): LedgerRecord {
  const { session, repo, now } = input;
  // An anchorless selection is looked for in the version the reviewer was
  // reading, which is the new one for every file the browser can show whole.
  const side = prompt.side ?? "new";
  const context = sliceContext(input.readFile(prompt.file, side), prompt);
  return buildAnnotationRecord({
    // Always the ledger's own: a thread id (`t4`) is unique only within its
    // session, and a ledger id must be unique across every session it holds.
    id: input.nextId("evt", now),
    at: now,
    round: roundOf(session),
    repo,
    branch: session.branch,
    base: session.base,
    ...commitFields(session),
    file: prompt.file,
    ...fileFields(findFile(session, prompt.file)),
    group: prompt.group,
    ...anchorOf(prompt),
    ...context,
    selected_text: prompt.selected_text,
    comment: prompt.comment,
  });
}

/**
 * A file the grouping does not list — a stale browser tab, a hand-written
 * prompt — yields nulls rather than a guess.
 */
function fileFields(file: DiffFile | undefined): {
  previous_path: string | null;
  file_status: DiffFileStatus | null;
  blob_new: string | null;
  blob_old: string | null;
} {
  const blobs = readBlobs(file?.diff ?? "");
  return {
    previous_path: file?.previousPath ?? null,
    file_status: file?.status ?? null,
    blob_new: blobs.new,
    blob_old: blobs.old,
  };
}

/** Sessions written before whole-file context existed have no commits to name. */
function commitFields(session: SessionRecord): {
  base_commit: string | null;
  head_commit: string | null;
} {
  return {
    base_commit: session.baseCommit ?? null,
    head_commit: session.headCommit ?? null,
  };
}

function messageRecord(input: FeedbackInput, prompt: { comment: string }): LedgerRecord {
  const { session, repo, now } = input;
  return buildMessageRecord({
    id: input.nextId("evt", now),
    at: now,
    round: roundOf(session),
    repo,
    branch: session.branch,
    base: session.base,
    comment: prompt.comment,
  });
}

export function agentReplyRecords(input: ReplyInput): LedgerRecord[] {
  const { session, repo, now } = input;
  return [
    buildAgentReplyRecord({
      id: input.nextId("evt", now),
      at: now,
      round: roundOf(session),
      repo,
      branch: session.branch,
      base: session.base,
      comment: input.comment,
    }),
  ];
}

export function roundEndRecords(input: EndInput): LedgerRecord[] {
  const { session, repo, now } = input;
  // Approval earned in this round and approval inherited from an earlier one
  // are different evidence, so the record states which is which.
  const carried = carriedApproval(session.rounds).filter((path) => session.approved.includes(path));
  return [
    buildRoundEndRecord({
      id: input.nextId("evt", now),
      at: now,
      round: roundOf(session),
      repo,
      branch: session.branch,
      base: session.base,
      approved: session.approved.filter((path) => !carried.includes(path)),
      carried,
    }),
  ];
}

/** Sessions created before the ledger existed carry no round id. */
function roundOf(session: SessionRecord): string {
  return session.round ?? "unknown";
}

function findFile(session: SessionRecord, path: string): DiffFile | undefined {
  return session.groups.flatMap((group) => group.files).find((file) => file.path === path);
}

/** `index 11ab34c..4c9f88d 100644` is the only place a patch names its blobs. */
export function readBlobs(patch: string): { old: string | null; new: string | null } {
  const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)/m.exec(patch);
  return { old: match?.[1] ?? null, new: match?.[2] ?? null };
}
