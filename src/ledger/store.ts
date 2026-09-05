import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FeedbackLogMode } from "../config.ts";
import { feedbackDirPath } from "../paths.ts";
import { LEDGER_KINDS, type LedgerRecord } from "./records.ts";

/** Resume/filter window for a read. `cursor` is the last id a caller already saw. */
export interface LedgerQuery {
  since?: string;
  cursor?: string;
  limit?: number;
  /** Only this kind of record. */
  kind?: LedgerRecord["kind"];
  /** Only records written for this repository root. */
  repo?: string;
  /**
   * Only records carrying one of these round ids. An `outcome` has no round of
   * its own (it names the round it judges), so this filter never matches one.
   */
  rounds?: readonly string[];
}

export interface LedgerReadResult {
  /** Oldest first, so a slice reads as a transcript. */
  records: LedgerRecord[];
  /** How many records matched before `limit` cut the list. */
  matched: number;
  /**
   * Unparseable lines seen among the lines the query looked at — a filtered read
   * skips files and lines, so it can report fewer. `stats()` is the full count.
   */
  corrupt: number;
  hasMore: boolean;
}

export interface LedgerStats {
  records: number;
  corrupt: number;
  months: number;
  bytes: number;
  first: string | undefined;
  last: string | undefined;
}

export type AppendResult = { ok: true } | { ok: false; reason: string };

export interface RewriteResult {
  removed: number;
  kept: number;
  /** Unparseable lines dropped on the way through, counted apart from removals. */
  corrupt: number;
}

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

/**
 * Append-only JSONL, one file per calendar month under `<stateDir>/feedback/`.
 * Deliberately dumb: it knows a record has an `id` and an `at` and nothing else,
 * and it never throws — a review must survive a full disk or a corrupt line.
 */
export class LedgerStore {
  readonly path: string;

  constructor(directory: string) {
    this.path = directory;
  }

  append(record: LedgerRecord): AppendResult {
    try {
      mkdirSync(this.path, { recursive: true });
      const file = join(this.path, `${monthOf(record.at)}.jsonl`);
      appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  }

  read(query: LedgerQuery): LedgerReadResult {
    const scan = this.#scan(query);
    const matched = scan.records.filter(
      (record) => afterCursor(record, query.cursor) && notBefore(record, query.since),
    );
    const limit = query.limit ?? matched.length;
    return {
      records: matched.slice(0, limit),
      matched: matched.length,
      corrupt: scan.corrupt,
      hasMore: matched.length > limit,
    };
  }

  /**
   * Temp-file-plus-rename per month so a reader never sees a half-written file;
   * an untouched month stays on disk as-is, mtime included. The only method that
   * may throw: `prune` must not report a false success, while append/read (which
   * a live review depends on) still never throws.
   */
  rewrite(keep: (record: LedgerRecord) => boolean): RewriteResult {
    const result: RewriteResult = { removed: 0, kept: 0, corrupt: 0 };
    for (const file of this.#monthFiles()) {
      const path = join(this.path, file);
      const parsed = readOrEmpty(path).split("\n").filter(hasContent).map(parseLine);
      const records = parsed.filter((record) => record !== undefined);
      const survivors = records.filter(keep);
      result.corrupt += parsed.length - records.length;
      result.kept += survivors.length;
      result.removed += records.length - survivors.length;
      if (survivors.length !== parsed.length) replaceFile(path, survivors);
    }
    return result;
  }

  stats(): LedgerStats {
    const scan = this.#scan({});
    return {
      records: scan.records.length,
      corrupt: scan.corrupt,
      months: scan.months,
      bytes: scan.bytes,
      first: scan.records[0]?.at,
      last: scan.records.at(-1)?.at,
    };
  }

  /**
   * Reads only the month files the query can match and parses only the lines
   * that survive a substring gate, so answering "this session's annotations"
   * costs the session's lines rather than every line the ledger ever took.
   */
  #scan(query: LedgerQuery): {
    records: LedgerRecord[];
    corrupt: number;
    months: number;
    bytes: number;
  } {
    const records: LedgerRecord[] = [];
    let corrupt = 0;
    let bytes = 0;
    const files = this.#monthFiles().filter((file) => monthInRange(file, query.since));
    for (const file of files) {
      const contents = readOrEmpty(join(this.path, file));
      bytes += Buffer.byteLength(contents);
      corrupt += collectMatches(contents, query, records);
    }
    records.sort(byTimeThenId);
    return { records, corrupt, months: files.length, bytes };
  }

  #monthFiles(): string[] {
    try {
      return readdirSync(this.path)
        .filter((entry) => MONTH_FILE.test(entry))
        .sort();
    } catch {
      return [];
    }
  }
}

/**
 * The opt-out is the absence of a store, not a store that discards writes: with
 * `feedbackLog: "off"` there is nothing to write through and no directory made.
 */
export function ledgerFor(mode: FeedbackLogMode, stateDir: string): LedgerStore | undefined {
  return mode === "off" ? undefined : new LedgerStore(feedbackDirPath(stateDir));
}

/** An emptied month is deleted rather than left as a zero-byte file. */
function replaceFile(path: string, records: LedgerRecord[]): void {
  if (records.length === 0) {
    rmSync(path);
    return;
  }
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  renameSync(temporary, path);
}

function hasContent(line: string): boolean {
  return line.trim().length > 0;
}

/** Parses a month file's matching lines into `into`, returning corrupt lines. */
function collectMatches(contents: string, query: LedgerQuery, into: LedgerRecord[]): number {
  let corrupt = 0;
  for (const line of contents.split("\n")) {
    if (!hasContent(line) || !lineMayMatch(line, query)) continue;
    const record = parseLine(line);
    if (record === undefined) corrupt += 1;
    else if (recordMatches(record, query)) into.push(record);
  }
  return corrupt;
}

/**
 * A cheap substring gate over the raw line: every filtered field is a JSON
 * string, so a line that cannot contain it cannot match, and skipping the
 * parse is where the saving is. False positives are fine — `recordMatches`
 * decides.
 */
function lineMayMatch(line: string, query: LedgerQuery): boolean {
  if (query.kind !== undefined && !line.includes(`"kind":${JSON.stringify(query.kind)}`)) {
    return false;
  }
  if (query.repo !== undefined && !line.includes(JSON.stringify(query.repo))) return false;
  return query.rounds === undefined || query.rounds.some((round) => line.includes(`"${round}"`));
}

function recordMatches(record: LedgerRecord, query: LedgerQuery): boolean {
  if (query.kind !== undefined && record.kind !== query.kind) return false;
  if (query.repo !== undefined && record.repo.root !== query.repo) return false;
  return matchesRound(record, query.rounds);
}

function matchesRound(record: LedgerRecord, rounds: readonly string[] | undefined): boolean {
  if (rounds === undefined) return true;
  return "round" in record && rounds.includes(record.round);
}

/**
 * A month whose every timestamp predates `since` holds nothing to read. Both
 * sides are ISO, so comparing the `YYYY-MM` prefixes is comparing the dates.
 */
function monthInRange(file: string, since: string | undefined): boolean {
  return since === undefined || file.slice(0, 7) >= since.slice(0, 7);
}

function readOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const KINDS: readonly string[] = LEDGER_KINDS;

/**
 * Usable only with the fields every reader dereferences without asking (id, at,
 * kind, repo). Anything less is corruption: handing it back typed would make
 * `export.ts` — pure code that trusts its input type — throw on a missing field.
 */
function parseLine(line: string): LedgerRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return hasRecordFields(parsed) ? (parsed as LedgerRecord) : undefined;
}

function hasRecordFields(parsed: object): boolean {
  const candidate = parsed as { id?: unknown; at?: unknown; kind?: unknown; repo?: unknown };
  if (typeof candidate.id !== "string" || typeof candidate.at !== "string") return false;
  if (typeof candidate.kind !== "string" || !KINDS.includes(candidate.kind)) return false;
  return isRepoRef(candidate.repo);
}

function isRepoRef(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { root?: unknown }).root === "string";
}

function byTimeThenId(left: LedgerRecord, right: LedgerRecord): number {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function afterCursor(record: LedgerRecord, cursor: string | undefined): boolean {
  return cursor === undefined || record.id > cursor;
}

function notBefore(record: LedgerRecord, since: string | undefined): boolean {
  return since === undefined || record.at >= since;
}

/** `YYYY-MM` of the record's own timestamp; today's month if it is unreadable. */
function monthOf(at: string): string {
  const month = /^\d{4}-\d{2}/.exec(at);
  return month?.[0] ?? new Date().toISOString().slice(0, 7);
}
