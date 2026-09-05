import type { DiffFileStatus } from "../diff-extract.ts";
import { ReviewError } from "../errors.ts";
import { renderToon } from "../output.ts";
import { anchorOf, contextOf, VERDICTS } from "./records.ts";
import type {
  AnchorFields,
  AnnotationRecord,
  CappedField,
  ContextFields,
  LedgerRecord,
  OutcomeRecord,
  RepoRef,
  RoundFileRecord,
  Verdict,
} from "./records.ts";

/**
 * Read side of the ledger: raw records in, self-contained items out. A miner
 * has no git and the repo may be gone, so an item copies everything it needs
 * from the annotation, its round file and its outcome. Pure: the store reads
 * lines, this joins and formats. `message`/`agent_reply` are deliberately not
 * items — an item is one piece of feedback about one file; raw JSONL keeps the rest.
 */
export interface ItemOutcome {
  next_round: string;
  from_commit: string | null;
  to_commit: string | null;
  file_touched: boolean;
  re_annotated: boolean;
  approved: boolean;
  response_patch?: string;
}

export type ExportItem = {
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
  /** The file's patch for that round, present only with `withPatches`. */
  patch?: string;
  /** Set when a patch existed but the render dropped it, so nothing is silent. */
  patch_omitted?: true;
  /** The same mark for the copied code context, dropped by the same switch. */
  context_omitted?: true;
  truncated: CappedField[];
  /** `unknown` until an outcome judges the annotation. */
  verdict: Verdict;
  outcome?: ItemOutcome;
} & AnchorFields &
  ContextFields;

export interface ItemFilters {
  /** Repository root, matched exactly: the ledger is global across repos. */
  repo?: string;
  since?: string;
  cursor?: string;
  limit?: number;
  verdict?: Verdict;
  /** Exact path, or a directory prefix such as `src/ledger`. */
  file?: string;
}

export interface SelectResult {
  /** Oldest first, so a slice reads as a transcript. */
  items: ExportItem[];
  /** How many items matched the filters before `limit` cut the list. */
  matched: number;
  hasMore: boolean;
  /** Last id returned — the caller's next `cursor`. */
  cursor: string | undefined;
}

export function selectItems(records: LedgerRecord[], filters: ItemFilters): SelectResult {
  const roundFiles = indexRoundFiles(records);
  const outcomes = indexOutcomes(records);
  const matched = records
    .filter(isAnnotation)
    .map((record) => joinItem(record, roundFiles, outcomes))
    .filter((item) => matchesFilters(item, filters))
    .sort(byTimeThenId);
  const items = matched.slice(0, filters.limit ?? matched.length);
  return {
    items,
    matched: matched.length,
    hasMore: matched.length > items.length,
    cursor: items.at(-1)?.id,
  };
}

export interface VerdictCounts extends Record<Verdict, number> {
  /** Items no outcome has judged yet — the summary's `unresolved`. */
  unresolved: number;
}

export function verdictCounts(items: ExportItem[]): VerdictCounts {
  const counts: VerdictCounts = {
    addressed: 0,
    ignored: 0,
    repeated: 0,
    unknown: 0,
    unresolved: 0,
  };
  for (const item of items) {
    counts[item.verdict] += 1;
    if (item.outcome === undefined) counts.unresolved += 1;
  }
  return counts;
}

export interface RepoRow extends Record<Verdict, number> {
  name: string;
  root: string;
  items: number;
}

/** Per-repository aggregates for the summary, so an agent never sums rows itself. */
export function repoRows(items: ExportItem[]): RepoRow[] {
  const rows = new Map<string, RepoRow>();
  for (const item of items) {
    const row = rows.get(item.repo.root) ?? emptyRepoRow(item.repo);
    row.items += 1;
    row[item.verdict] += 1;
    rows.set(item.repo.root, row);
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function emptyRepoRow(repo: RepoRef): RepoRow {
  return {
    name: repo.name,
    root: repo.root,
    items: 0,
    addressed: 0,
    ignored: 0,
    repeated: 0,
    unknown: 0,
  };
}

export const EXPORT_FORMATS = ["toon", "jsonl", "md"] as const;

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface RenderOptions {
  format: ExportFormat;
  withPatches?: boolean;
  maxBytes?: number;
}

interface RenderCounts {
  included: number;
  /** Items dropped whole by the byte budget — never half a record. */
  omitted: number;
  /** Included items carrying a field the write path had to cap. */
  truncated: number;
  cursor: string | undefined;
  bytes: number;
}

/**
 * TOON hands back objects because the command embeds them in one TOON payload
 * next to `help[]`; JSONL and Markdown are printed as they are.
 */
export type RenderedItems =
  | (RenderCounts & { format: "toon"; items: ExportItem[] })
  | (RenderCounts & { format: "jsonl"; text: string })
  | (RenderCounts & { format: "md"; text: string });

type Renderer = (items: ExportItem[], maxBytes: number | undefined) => RenderedItems;

/** One named function per format; `Record<ExportFormat, …>` keeps the set closed. */
const RENDERERS = {
  toon: renderToonItems,
  jsonl: renderJsonlItems,
  md: renderMarkdownItems,
} as const satisfies Record<ExportFormat, Renderer>;

export function renderItems(items: ExportItem[], options: RenderOptions): RenderedItems {
  const prepared = items.map((item) => forDisplay(item, options.withPatches === true));
  return RENDERERS[options.format](prepared, options.maxBytes);
}

function renderToonItems(items: ExportItem[], maxBytes: number | undefined): RenderedItems {
  const kept = fitBudget(items, toonProbeBytes, maxBytes);
  return {
    format: "toon",
    items: kept,
    // No items means no payload: the empty TOON table header is not a byte the
    // caller received, and reporting it would make a zero result look non-empty.
    ...counts(items, kept, kept.length === 0 ? 0 : Buffer.byteLength(renderToon({ items: kept }))),
  };
}

function renderJsonlItems(items: ExportItem[], maxBytes: number | undefined): RenderedItems {
  const kept = fitBudget(items, (item) => Buffer.byteLength(jsonlLine(item)), maxBytes);
  const text = kept.map(jsonlLine).join("");
  return { format: "jsonl", text, ...counts(items, kept, Buffer.byteLength(text)) };
}

function renderMarkdownItems(items: ExportItem[], maxBytes: number | undefined): RenderedItems {
  const kept = fitBudget(items, (item) => Buffer.byteLength(markdownSection(item)), maxBytes);
  const text = kept.map(markdownSection).join("");
  return { format: "md", text, ...counts(items, kept, Buffer.byteLength(text)) };
}

/**
 * Keeps the oldest items that fit, so what is dropped is always a contiguous
 * newest tail the caller can fetch next with the returned `cursor`.
 */
function fitBudget(
  items: ExportItem[],
  size: (item: ExportItem) => number,
  maxBytes: number | undefined,
): ExportItem[] {
  if (maxBytes === undefined) return items;
  const kept: ExportItem[] = [];
  let used = 0;
  for (const item of items) {
    const cost = size(item);
    if (used + cost > maxBytes) break;
    used += cost;
    kept.push(item);
  }
  return kept;
}

function counts(all: ExportItem[], kept: ExportItem[], bytes: number): RenderCounts {
  return {
    included: kept.length,
    omitted: all.length - kept.length,
    truncated: kept.filter((item) => item.truncated.length > 0).length,
    cursor: kept.at(-1)?.id,
    bytes,
  };
}

/**
 * A whole TOON table shares one header, so encoding an item alone over-counts —
 * the budget therefore errs below `maxBytes`, never above it.
 */
function toonProbeBytes(item: ExportItem): number {
  return Buffer.byteLength(renderToon({ items: [item] }));
}

function jsonlLine(item: ExportItem): string {
  return `${JSON.stringify(item)}\n`;
}

function markdownSection(item: ExportItem): string {
  const lines = [
    `## ${item.id} — ${item.file} (${item.verdict})`,
    "",
    `- at: ${item.at}`,
    `- repo: ${item.repo.name} (${item.repo.root})`,
    `- branch: ${item.branch} onto ${item.base}, head ${item.head_commit ?? "unknown"}`,
    `- round: ${item.round}, group ${item.group}, status ${item.file_status ?? "unknown"}`,
    `- lines: ${lineRange(item)}`,
    "",
    "### comment",
    "",
    item.comment,
    "",
    "### selected",
    "",
    "```",
    item.selected_text,
    "```",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function lineRange(item: ExportItem): string {
  if (item.side === undefined) return "unknown";
  return `${position(item.line_start, item.col_start)}-${position(item.line_end, item.col_end)} (${item.side})`;
}

/** `214:5` when the reviewer clipped that line, plain `214` when they took it whole. */
function position(line: number, column: number | undefined): string {
  return column === undefined ? `${line}` : `${line}:${column}`;
}

/**
 * Patches and copied code context are the bulk of an item, so `list` drops both
 * and says that it did; `show` and `--with-patches` are how they come back. One
 * switch over both, because two switches cost the reader more than the bytes.
 */
function forDisplay(item: ExportItem, withPatches: boolean): ExportItem {
  if (withPatches) return item;
  const hadPatch = item.patch !== undefined || item.outcome?.response_patch !== undefined;
  const hadContext = item.context !== undefined;
  // A partial view because `ContextFields` calls the text mandatory wherever the
  // pair appears, and the text and its source only ever travel together.
  const stripped: Partial<ExportItem> = { ...item };
  delete stripped.patch;
  delete stripped.context;
  delete stripped.context_source;
  if (stripped.outcome !== undefined) {
    stripped.outcome = { ...stripped.outcome };
    delete stripped.outcome.response_patch;
  }
  if (hadPatch) stripped.patch_omitted = true;
  if (hadContext) stripped.context_omitted = true;
  return stripped as ExportItem;
}

type RoundFileIndex = Map<string, RoundFileRecord>;
type OutcomeIndex = Map<string, OutcomeRecord>;

function indexRoundFiles(records: LedgerRecord[]): RoundFileIndex {
  const index: RoundFileIndex = new Map();
  for (const record of records) {
    if (record.kind === "round_file") index.set(roundFileKey(record.round, record.file), record);
  }
  return index;
}

/** A later round can re-judge the same annotation; the newest outcome wins. */
function indexOutcomes(records: LedgerRecord[]): OutcomeIndex {
  const index: OutcomeIndex = new Map();
  for (const record of records) {
    if (record.kind === "outcome") index.set(record.about, record);
  }
  return index;
}

function roundFileKey(round: string, file: string): string {
  return `${round}\u0000${file}`;
}

function isAnnotation(record: LedgerRecord): record is AnnotationRecord {
  return record.kind === "annotation";
}

function joinItem(
  record: AnnotationRecord,
  roundFiles: RoundFileIndex,
  outcomes: OutcomeIndex,
): ExportItem {
  const roundFile = roundFiles.get(roundFileKey(record.round, record.file));
  const outcome = outcomes.get(record.id);
  return {
    id: record.id,
    at: record.at,
    round: record.round,
    repo: record.repo,
    branch: record.branch,
    base: record.base,
    base_commit: record.base_commit,
    head_commit: record.head_commit,
    file: record.file,
    group: record.group,
    ...fileFacts(record, roundFile),
    ...anchorOf(record),
    selected_text: record.selected_text,
    comment: record.comment,
    ...contextOf(record),
    // Lines written before `truncated[]` existed are still schema 1: nothing was
    // capped on them, so an absent list reads as an empty one rather than a crash.
    truncated: record.truncated ?? [],
    verdict: verdictOf(outcome),
    ...(outcome === undefined ? {} : { outcome: itemOutcome(outcome) }),
  };
}

/**
 * What the annotation knows about the file, filled in from the round file where
 * a stale browser tab left it blank — and the round's patch for that file.
 */
function fileFacts(
  record: AnnotationRecord,
  roundFile: RoundFileRecord | undefined,
): Pick<ExportItem, "previous_path" | "file_status" | "blob_new" | "blob_old" | "patch"> {
  const known = roundFile ?? EMPTY_FILE_FACTS;
  return {
    previous_path: record.previous_path ?? known.previous_path,
    file_status: record.file_status ?? known.file_status,
    blob_new: record.blob_new ?? known.blob_new,
    blob_old: record.blob_old ?? known.blob_old,
    ...(roundFile === undefined ? {} : { patch: roundFile.patch }),
  };
}

const EMPTY_FILE_FACTS = {
  previous_path: null,
  file_status: null,
  blob_new: null,
  blob_old: null,
} as const;

const KNOWN_VERDICTS: ReadonlySet<string> = new Set(VERDICTS);

/**
 * The one place a verdict enters the read side, so every consumer downstream
 * gets one of `VERDICTS` by construction: the counts are keyed by it, and a
 * verdict off the list would silently add a column instead of a total.
 */
function verdictOf(outcome: OutcomeRecord | undefined): Verdict {
  if (outcome === undefined || !KNOWN_VERDICTS.has(outcome.verdict)) return "unknown";
  return outcome.verdict;
}

function itemOutcome(record: OutcomeRecord): ItemOutcome {
  return {
    next_round: record.next_round,
    from_commit: record.from_commit,
    to_commit: record.to_commit,
    file_touched: record.file_touched,
    re_annotated: record.re_annotated,
    approved: record.approved,
    ...(record.response_patch === undefined ? {} : { response_patch: record.response_patch }),
  };
}

function matchesFilters(item: ExportItem, filters: ItemFilters): boolean {
  return (
    matchesRepo(item, filters.repo) &&
    notBefore(item, filters.since) &&
    afterCursor(item, filters.cursor) &&
    matchesVerdict(item, filters.verdict) &&
    matchesFile(item, filters.file)
  );
}

function matchesRepo(item: ExportItem, repo: string | undefined): boolean {
  return repo === undefined || item.repo.root === repo;
}

function notBefore(item: ExportItem, since: string | undefined): boolean {
  return since === undefined || item.at >= since;
}

function afterCursor(item: ExportItem, cursor: string | undefined): boolean {
  return cursor === undefined || item.id > cursor;
}

function matchesVerdict(item: ExportItem, verdict: Verdict | undefined): boolean {
  return verdict === undefined || item.verdict === verdict;
}

function matchesFile(item: ExportItem, file: string | undefined): boolean {
  if (file === undefined || item.file === file) return true;
  const directory = file.endsWith("/") ? file : `${file}/`;
  return item.file.startsWith(directory);
}

function byTimeThenId(left: ExportItem, right: ExportItem): number {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

const DURATION = /^(\d+)([smhdw])$/;

const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

type DurationUnit = keyof typeof UNIT_MS;

/**
 * `--since` takes either an instant (`2026-01-04`, a full ISO timestamp) or a
 * duration back from now (`30d`, `12h`, `2w`), and always yields an ISO string,
 * so filtering stays a plain string comparison.
 */
export function parseSince(value: string, now = new Date()): string {
  const trimmed = value.trim();
  const duration = DURATION.exec(trimmed);
  if (duration !== null) {
    const unit = duration[2] as DurationUnit;
    return new Date(now.getTime() - Number(duration[1]) * UNIT_MS[unit]).toISOString();
  }
  const instant = Date.parse(trimmed);
  if (!Number.isNaN(instant)) return new Date(instant).toISOString();
  throw new ReviewError({
    code: "invalid_arguments",
    message: `--since expects a date or a duration, got "${value}"`,
    detail: "Use an ISO date (2026-01-04), an ISO timestamp, or a duration: 45m, 12h, 30d, 2w",
    suggestions: [
      "lightspeed feedback list --since 30d",
      "lightspeed feedback list --since 2026-01-04",
    ],
  });
}
