import { resolve } from "node:path";
import { ReviewError, validationError } from "../../errors.ts";
import { EXPORT_FORMATS, type ExportFormat } from "../../ledger/export.ts";
import type { LedgerStore } from "../../ledger/store.ts";
import { scanArgs } from "../args.ts";

/** What every feedback subcommand shares: the dispatcher's context, the flag scan
 * and readers, and the help lines subcommands point at one another with. */
export interface FeedbackContext {
  /** Absent when `feedbackLog` is `off` — there is nothing to read or prune. */
  store: LedgerStore | undefined;
  path: string;
  repoRoot: string | undefined;
  now: Date;
}

/**
 * A bare `list` is read by an agent with a context window, so the unguarded
 * command must cost about one answer, not the whole ledger. Twenty items is a
 * page a reader still holds in one head, and the cursor makes the rest one
 * command away.
 */
export const DEFAULT_LIST_LIMIT = 20;

/**
 * Roughly 12k tokens: room for a full page of ordinary items, and a ceiling a
 * few pathological ones cannot blow past, since an item carries copied code.
 */
export const DEFAULT_LIST_MAX_BYTES = 50_000;

export const HELP_LIST =
  "Run `lightspeed feedback list --repo . --since 30d` to read recent feedback";
export const HELP_SHOW =
  "Run `lightspeed feedback show <id>` for one item with its full patch and context";
export const HELP_PRUNE =
  "Run `lightspeed feedback prune --before <date> [--repo <path>]` to drop old records";
export const HELP_PRUNE_DRY =
  "Add `--dry-run` to print this same breakdown without touching a single file";
export const HELP_PRUNE_WET =
  "Nothing was deleted: re-run the same command without `--dry-run` to apply it";
export const HELP_PRUNE_FINAL =
  "A prune cannot be undone: records are deleted from disk and there is no backup";
export const HELP_FORMATS =
  "Add `--format jsonl` for bulk ingest or `--format md` for prompt stuffing; both print raw text";
export const HELP_ENABLE =
  'Set `"feedbackLog": "on"` in .lightspeed.conf.json to record review feedback again';
export const HELP_BUDGET =
  "Raise `--max-bytes`, or keep the budget and resume from the reported cursor for the rest";
export const HELP_CAPS =
  `A bare list stops at ${DEFAULT_LIST_LIMIT} items and ${DEFAULT_LIST_MAX_BYTES} bytes:` +
  " raise `--limit` or `--max-bytes`, or follow the cursor, for what it held back";
export const HELP_BULK_FIELDS =
  "Add `--with-patches` to keep the round patch and the code context every listed item drops";

export interface ParsedArgs {
  positional: string[];
  /** Raw flag values, converted by the subcommand that accepts them. */
  values: Partial<Record<string, string>>;
  present: Set<string>;
}

/** Flags that stand alone; everything else in the allow-list takes a value. */
const BOOLEAN_FLAGS = new Set(["--with-patches", "--dry-run"]);

/** One scan per subcommand, given its allow-list: an unknown or misplaced flag is
 * exit 2, not a quiet positional. `values: "bare"` + `onMissingValue` means a flag
 * never eats the flag after it — `--since --format` is a missing value. */
export function parseArgs(args: string[], allowed: readonly string[]): ParsedArgs {
  const scanned = scanArgs(args, {
    value: allowed.filter((flag) => !BOOLEAN_FLAGS.has(flag)),
    boolean: allowed.filter((flag) => BOOLEAN_FLAGS.has(flag)),
    onUnknown: (flag) => unknownFlag(flag, allowed),
    onMissingValue: missingValue,
    values: "bare",
    flagPrefix: "-",
  });
  const parsed: ParsedArgs = { positional: scanned.positional, values: {}, present: new Set() };
  for (const { flag, value } of scanned.flags) {
    parsed.present.add(flag);
    if (value !== undefined) parsed.values[flag] = value;
  }
  return parsed;
}

function missingValue(flag: string): Error {
  return new ReviewError({
    code: "invalid_arguments",
    message: `${flag} needs a value`,
    suggestions: [HELP_LIST, HELP_PRUNE],
  });
}

export function unknownFlag(flag: string, allowed: readonly string[]): Error {
  return validationError(`unknown flag ${flag}`, [
    `Known here: ${allowed.join(", ")}`,
    "Run `lightspeed feedback --help` for every subcommand and flag",
  ]);
}

/** Bulk formats print raw: an agent piping JSONL must not strip a TOON envelope,
 * and the TOON path carries the aggregates. The CLI terminates the last line,
 * hence the trim. */
export function rawText(text: string): string {
  return text.trimEnd();
}

export function readFormat(parsed: ParsedArgs): ExportFormat {
  const value = parsed.values["--format"];
  if (value === undefined) return "toon";
  const formats: readonly string[] = EXPORT_FORMATS;
  if (!formats.includes(value)) {
    throw new ReviewError({
      code: "invalid_arguments",
      message: `--format expects one of ${EXPORT_FORMATS.join(", ")}, got "${value}"`,
      detail: "toon is the default; jsonl and md print raw text",
      suggestions: [HELP_FORMATS],
    });
  }
  return value as ExportFormat;
}

export function readCount(parsed: ParsedArgs, flag: string): number {
  const value = parsed.values[flag]!;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1) {
    throw new ReviewError({
      code: "invalid_arguments",
      message: `${flag} expects a positive whole number, got "${value}"`,
      suggestions: [HELP_LIST],
    });
  }
  return count;
}

/** `--repo .` is the repository the command runs in; anything else is a path. */
export function readRepo(parsed: ParsedArgs, context: FeedbackContext): string | undefined {
  const value = parsed.values["--repo"];
  if (value === undefined) return undefined;
  if (value !== "." && value !== "./") return resolve(value);
  if (context.repoRoot === undefined) throw noRepoHere();
  return context.repoRoot;
}

/** Reading the ledger needs no repository, but `--repo .` names one and there is
 * none here — filtering by the wrong repo would answer a question nobody asked. */
function noRepoHere(): ReviewError {
  return new ReviewError({
    code: "git_repo_not_found",
    message: "`--repo .` needs a repository, and this directory is not inside one",
    detail: "the ledger itself is global: drop `--repo` to read every repository",
    suggestions: [
      "Run `lightspeed feedback list` for every repository in the ledger",
      "Pass `--repo <path>` to filter by a repository root explicitly",
    ],
  });
}

export function requireStore(context: FeedbackContext): LedgerStore {
  if (context.store === undefined) {
    throw new ReviewError({
      code: "ledger_disabled",
      message: "the feedback ledger is off in .lightspeed.conf.json",
      detail: `nothing is read from or written to ${context.path} while it is off`,
      suggestions: [HELP_ENABLE],
    });
  }
  return context.store;
}
