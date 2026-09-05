import type { DiffFileStatus, DiffStats } from "../diff-extract.ts";
import type { Approval } from "../rounds/history.ts";

/**
 * The append-only ledger's wire format: one JSON object per line, `schema: 1`,
 * snake_case — the shape a mining agent reads, so types and builders live here.
 * Evolution is additive only: a reader of an old line must keep working.
 */
export const LEDGER_SCHEMA = 1;

export const LEDGER_KINDS = [
  "round",
  "round_file",
  "annotation",
  "message",
  "agent_reply",
  "declaration",
  "round_end",
  "outcome",
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const VERDICTS = ["addressed", "ignored", "repeated", "unknown"] as const;

export type Verdict = (typeof VERDICTS)[number];

/** Which side of the diff a selection was made on. */
export type AnnotationSide = "old" | "new";

/** The line range a selection covers in one version of a file. */
export interface LineAnchor {
  side: AnnotationSide;
  line_start: number;
  line_end: number;
  /**
   * Selection bounds on `line_start`/`line_end`, 1-based inclusive UTF-16 code
   * units (no `+`/`-` marker). An absent end means that boundary line was taken
   * whole, so full-line annotations serialise as before columns existed.
   */
  col_start?: number;
  col_end?: number;
}

/**
 * An anchor flattened into the record that carries it. The union makes half an
 * anchor — which locates nothing — unrepresentable.
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

/** How an annotation's stored context was located in the file it was made on. */
export type ContextSource = "anchor" | "search" | "none";

/**
 * Stored context and where it came from, paired so neither can appear alone:
 * text is always attributable, and "none" never carries text. Both are absent
 * on annotations written before context slicing existed.
 */
export type ContextFields =
  | { context: string; context_source: "anchor" | "search" }
  | { context?: undefined; context_source?: "none" };

/** Repo identity travels with every record: the ledger is global across repos. */
export interface RepoRef {
  root: string;
  name: string;
  remote: string | null;
}

interface RecordBase {
  schema: typeof LEDGER_SCHEMA;
  id: string;
  at: string;
}

export interface RoundRecord extends RecordBase {
  kind: "round";
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  base_commit: string | null;
  head_commit: string | null;
  stats: DiffStats;
  /** Group names in display order. */
  groups: string[];
}

export interface RoundFileRecord extends RecordBase {
  kind: "round_file";
  round: string;
  repo: RepoRef;
  file: string;
  /** Where the file stood with the reviewer when this round opened. */
  approval: Approval;
  /**
   * The round index this file entered the review in — not when git first saw
   * it. Written down because sessions are overwritten and deleted: without it
   * the mining agent cannot ask how long a file sat unapproved.
   */
  first_seen_round: number;
  previous_path: string | null;
  file_status: DiffFileStatus;
  group: string;
  blob_new: string | null;
  blob_old: string | null;
  patch: string;
  truncated: CappedField[];
}

export type AnnotationRecord = RecordBase & {
  kind: "annotation";
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  base_commit: string | null;
  head_commit: string | null;
  file: string;
  previous_path: string | null;
  /** Null when the round no longer lists the annotated file, e.g. a stale tab. */
  file_status: DiffFileStatus | null;
  group: string;
  blob_new: string | null;
  blob_old: string | null;
  selected_text: string;
  comment: string;
  truncated: CappedField[];
} & AnchorFields &
  ContextFields;

export interface MessageRecord extends RecordBase {
  kind: "message";
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  comment: string;
  truncated: CappedField[];
}

export interface AgentReplyRecord extends RecordBase {
  kind: "agent_reply";
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  comment: string;
  truncated: CappedField[];
}

/**
 * The agent's own account of one comment: files it led to, the answering note.
 * Recorded verbatim beside the mechanical `outcome`, never merged with it.
 * Every accepted declaration is appended (re-sends, corrections); the standing
 * answer is the last record per `about` — the session keeps only that winner.
 */
export interface DeclarationRecord extends RecordBase {
  kind: "declaration";
  /** The round open when the agent declared — the one answering the comment. */
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  /** Id of the annotation this declaration is about. */
  about: string;
  /** Paths the comment led to changes in; empty for a question or a decision. */
  files: string[];
  note?: string;
  truncated: CappedField[];
}

export interface RoundEndRecord extends RecordBase {
  kind: "round_end";
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  /** Paths the reviewer approved during this round. */
  approved: string[];
  /**
   * Paths that arrived already approved from an earlier round and still were
   * when it ended, so a miner never has to guess whether a tick was earned here.
   */
  carried: string[];
}

export interface OutcomeRecord extends RecordBase {
  kind: "outcome";
  repo: RepoRef;
  /** Id of the annotation this outcome judges. */
  about: string;
  next_round: string;
  from_commit: string | null;
  to_commit: string | null;
  file_touched: boolean;
  response_patch?: string;
  re_annotated: boolean;
  approved: boolean;
  verdict: Verdict;
  truncated: CappedField[];
}

export type LedgerRecord =
  | RoundRecord
  | RoundFileRecord
  | AnnotationRecord
  | MessageRecord
  | AgentReplyRecord
  | DeclarationRecord
  | RoundEndRecord
  | OutcomeRecord;

export type CappedField =
  "selected_text" | "comment" | "context" | "note" | "patch" | "response_patch";

/**
 * Hard caps per stored string. The ledger copies code so items stay readable
 * without git; these numbers stop one pathological round from filling a disk.
 */
export const FIELD_CAPS: Record<CappedField, { bytes: number; lines?: number }> = {
  selected_text: { bytes: 4 * 1024 },
  context: { bytes: 8 * 1024 },
  comment: { bytes: 16 * 1024 },
  note: { bytes: 16 * 1024 },
  patch: { bytes: 64 * 1024, lines: 2000 },
  response_patch: { bytes: 64 * 1024, lines: 2000 },
};

type CappedInput = Partial<Record<CappedField, string | undefined>>;

/**
 * The only writer of `truncated[]`. Every builder routes its long strings
 * through here, so a capped field cannot end up unmarked.
 */
export function capFields<T extends CappedInput>(
  fields: T,
): { values: T; truncated: CappedField[] } {
  const values = { ...fields };
  const truncated: CappedField[] = [];
  for (const [name, value] of Object.entries(fields) as [CappedField, string | undefined][]) {
    if (value === undefined) continue;
    const cap = FIELD_CAPS[name];
    const cut = truncateBytes(truncateLines(value, cap.lines), cap.bytes);
    if (cut === value) continue;
    (values as CappedInput)[name] = cut;
    truncated.push(name);
  }
  return { values, truncated };
}

function truncateLines(value: string, limit: number | undefined): string {
  if (limit === undefined) return value;
  const lines = value.split("\n");
  return lines.length <= limit ? value : lines.slice(0, limit).join("\n");
}

/** Cuts on a UTF-8 boundary, so a capped field never ends in a broken character. */
function truncateBytes(value: string, limit: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return value;
  let end = limit;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** Mints record ids in the order they are asked for. One per writer. */
export type IdSource = (prefix: "evt" | "rnd", at: string) => string;

/**
 * `evt_<base36 millis, zero-padded>_<4 hex sequence>`: string-sortable, so a
 * miner can use the last id seen as a watermark; the sequence orders same-
 * millisecond records. The counter belongs to the source, not this module, so
 * ordering is one writer's property rather than hidden shared state. 16-bit
 * limits: wraps after 65536 ids, restarts per process — ids repeat only across
 * two runs writing in the same millisecond.
 */
export function createIdSource(): IdSource {
  let sequence = 0;
  return (prefix, at) => {
    const millis = Date.parse(at);
    const stamp = (Number.isNaN(millis) ? 0 : millis).toString(36).padStart(9, "0");
    sequence = (sequence + 1) % 0x10000;
    return `${prefix}_${stamp}_${sequence.toString(16).padStart(4, "0")}`;
  };
}

export interface RoundInput {
  id: string;
  at: string;
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  base_commit: string | null;
  head_commit: string | null;
  stats: DiffStats;
  groups: string[];
}

export function buildRoundRecord(input: RoundInput): RoundRecord {
  return {
    schema: LEDGER_SCHEMA,
    id: input.id,
    at: input.at,
    kind: "round",
    round: input.round,
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    base_commit: input.base_commit,
    head_commit: input.head_commit,
    stats: input.stats,
    groups: input.groups,
  };
}

export interface RoundFileInput {
  id: string;
  at: string;
  round: string;
  repo: RepoRef;
  file: string;
  previous_path: string | null;
  file_status: DiffFileStatus;
  group: string;
  blob_new: string | null;
  blob_old: string | null;
  patch: string;
  approval: Approval;
  first_seen_round: number;
}

export function buildRoundFileRecord(input: RoundFileInput): RoundFileRecord {
  const capped = capFields({ patch: input.patch });
  return {
    schema: LEDGER_SCHEMA,
    id: input.id,
    at: input.at,
    kind: "round_file",
    round: input.round,
    repo: input.repo,
    file: input.file,
    approval: input.approval,
    first_seen_round: input.first_seen_round,
    previous_path: input.previous_path,
    file_status: input.file_status,
    group: input.group,
    blob_new: input.blob_new,
    blob_old: input.blob_old,
    patch: capped.values.patch,
    truncated: capped.truncated,
  };
}

export type AnnotationInput = {
  id: string;
  at: string;
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  base_commit: string | null;
  head_commit: string | null;
  file: string;
  previous_path: string | null;
  file_status: DiffFileStatus | null;
  group: string;
  blob_new: string | null;
  blob_old: string | null;
  selected_text: string;
  comment: string;
} & AnchorFields &
  ContextFields;

/**
 * The anchor of anything that carries one, as fields to spread. Absent fields
 * are left out entirely so an anchorless record serialises without them.
 */
export function anchorOf(source: AnchorFields): AnchorFields {
  if (source.side === undefined) return {};
  return {
    side: source.side,
    line_start: source.line_start,
    line_end: source.line_end,
    ...(source.col_start === undefined ? {} : { col_start: source.col_start }),
    ...(source.col_end === undefined ? {} : { col_end: source.col_end }),
  };
}

/**
 * Context as fields to spread, taking `capped` over the original text when the
 * caller has a shortened copy. Context with no text to store serialises without
 * either field, so an annotation that found none stays a small line.
 */
export function contextOf(source: ContextFields, capped?: string): ContextFields {
  if (source.context === undefined) {
    return source.context_source === undefined ? {} : { context_source: source.context_source };
  }
  return { context: capped ?? source.context, context_source: source.context_source };
}

export function buildAnnotationRecord(input: AnnotationInput): AnnotationRecord {
  const capped = capFields({
    selected_text: input.selected_text,
    comment: input.comment,
    context: input.context,
  });
  return {
    schema: LEDGER_SCHEMA,
    id: input.id,
    at: input.at,
    kind: "annotation",
    round: input.round,
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    base_commit: input.base_commit,
    head_commit: input.head_commit,
    file: input.file,
    previous_path: input.previous_path,
    file_status: input.file_status,
    group: input.group,
    blob_new: input.blob_new,
    blob_old: input.blob_old,
    ...anchorOf(input),
    selected_text: capped.values.selected_text,
    comment: capped.values.comment,
    ...contextOf(input, capped.values.context),
    truncated: capped.truncated,
  };
}

export interface MessageInput {
  id: string;
  at: string;
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  comment: string;
}

export function buildMessageRecord(input: MessageInput): MessageRecord {
  const capped = capFields({ comment: input.comment });
  return {
    schema: LEDGER_SCHEMA,
    id: input.id,
    at: input.at,
    kind: "message",
    round: input.round,
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    comment: capped.values.comment,
    truncated: capped.truncated,
  };
}

export function buildAgentReplyRecord(input: MessageInput): AgentReplyRecord {
  const capped = capFields({ comment: input.comment });
  return {
    schema: LEDGER_SCHEMA,
    id: input.id,
    at: input.at,
    kind: "agent_reply",
    round: input.round,
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    comment: capped.values.comment,
    truncated: capped.truncated,
  };
}

export interface DeclarationInput {
  id: string;
  at: string;
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  about: string;
  files: string[];
  note?: string;
}

export function buildDeclarationRecord(input: DeclarationInput): DeclarationRecord {
  const capped = capFields({ note: input.note });
  return {
    schema: LEDGER_SCHEMA,
    id: input.id,
    at: input.at,
    kind: "declaration",
    round: input.round,
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    about: input.about,
    files: input.files,
    ...(capped.values.note === undefined ? {} : { note: capped.values.note }),
    truncated: capped.truncated,
  };
}

export interface RoundEndInput {
  id: string;
  at: string;
  round: string;
  repo: RepoRef;
  branch: string;
  base: string;
  approved: string[];
  carried: string[];
}

export function buildRoundEndRecord(input: RoundEndInput): RoundEndRecord {
  return {
    schema: LEDGER_SCHEMA,
    id: input.id,
    at: input.at,
    kind: "round_end",
    round: input.round,
    repo: input.repo,
    branch: input.branch,
    base: input.base,
    approved: input.approved,
    carried: input.carried,
  };
}

export interface OutcomeInput {
  id: string;
  at: string;
  repo: RepoRef;
  about: string;
  next_round: string;
  from_commit: string | null;
  to_commit: string | null;
  file_touched: boolean;
  response_patch?: string;
  re_annotated: boolean;
  approved: boolean;
  verdict: Verdict;
}

export function buildOutcomeRecord(input: OutcomeInput): OutcomeRecord {
  const capped = capFields({ response_patch: input.response_patch });
  return {
    schema: LEDGER_SCHEMA,
    id: input.id,
    at: input.at,
    kind: "outcome",
    repo: input.repo,
    about: input.about,
    next_round: input.next_round,
    from_commit: input.from_commit,
    to_commit: input.to_commit,
    file_touched: input.file_touched,
    ...(capped.values.response_patch === undefined
      ? {}
      : { response_patch: capped.values.response_patch }),
    re_annotated: input.re_annotated,
    approved: input.approved,
    verdict: input.verdict,
    truncated: capped.truncated,
  };
}
