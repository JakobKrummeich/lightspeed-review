import { ReviewError } from "../../errors.ts";
import {
  parseSince,
  renderItems,
  selectItems,
  type ExportFormat,
  type ItemFilters,
  type RenderedItems,
  type SelectResult,
} from "../../ledger/export.ts";
import { VERDICTS, type Verdict } from "../../ledger/records.ts";
import type { StructuredOutput } from "../../output.ts";
import { HELP_START } from "../home.ts";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_LIST_MAX_BYTES,
  HELP_BUDGET,
  HELP_BULK_FIELDS,
  HELP_CAPS,
  HELP_FORMATS,
  HELP_LIST,
  HELP_SHOW,
  parseArgs,
  rawText,
  readCount,
  readFormat,
  readRepo,
  requireStore,
  type FeedbackContext,
  type ParsedArgs,
} from "./shared.ts";

const LIST_FLAGS = [
  "--repo",
  "--since",
  "--cursor",
  "--limit",
  "--verdict",
  "--file",
  "--format",
  "--max-bytes",
  "--with-patches",
] as const;

export function listFeedback(args: string[], context: FeedbackContext): StructuredOutput | string {
  const parsed = parseArgs(args, LIST_FLAGS);
  const format = readFormat(parsed);
  const caps = listCaps(parsed, format);
  const filters = listFilters(parsed, context, caps.limit);
  const selection = selectItems(requireStore(context).read({}).records, filters);
  const rendered = renderItems(selection.items, {
    format,
    withPatches: parsed.present.has("--with-patches"),
    ...(caps.maxBytes === undefined ? {} : { maxBytes: caps.maxBytes }),
  });
  if (rendered.included === 0) return emptyList(rendered, selection, filters);
  if (rendered.format !== "toon") return rawText(rendered.text);
  return {
    items: rendered.items,
    count: countBlock(rendered, selection),
    ...(rendered.cursor === undefined ? {} : { cursor: rendered.cursor }),
    ...filterBlock(filters),
    help: listHelp(rendered, selection, cutByDefault(parsed, rendered, selection)),
  };
}

interface ListCaps {
  limit: number | undefined;
  maxBytes: number | undefined;
}

/**
 * The caps a list runs under. They default only for TOON, which reports the
 * arithmetic in `count` and prints the cursor: `jsonl` and `md` return raw text
 * with no such block, so a cut nobody asked for would be invisible to the pipe
 * reading them. An explicit flag always wins over the default.
 */
function listCaps(parsed: ParsedArgs, format: ExportFormat): ListCaps {
  const defaulted = format === "toon";
  return {
    limit: cap(parsed, "--limit", defaulted ? DEFAULT_LIST_LIMIT : undefined),
    maxBytes: cap(parsed, "--max-bytes", defaulted ? DEFAULT_LIST_MAX_BYTES : undefined),
  };
}

function cap(parsed: ParsedArgs, flag: string, fallback: number | undefined): number | undefined {
  return parsed.values[flag] === undefined ? fallback : readCount(parsed, flag);
}

/** Whether a cap the caller never chose is what held items back — the only case
 * where the answer owes them the flags that lift it. */
function cutByDefault(
  parsed: ParsedArgs,
  rendered: RenderedItems,
  selection: SelectResult,
): boolean {
  const byLimit = !parsed.present.has("--limit") && selection.hasMore;
  const byBudget = !parsed.present.has("--max-bytes") && rendered.omitted > 0;
  return byLimit || byBudget;
}

function listFilters(
  parsed: ParsedArgs,
  context: FeedbackContext,
  limit: number | undefined,
): ItemFilters {
  const repo = readRepo(parsed, context);
  const since = parsed.values["--since"];
  const verdict = parsed.values["--verdict"];
  return {
    ...(repo === undefined ? {} : { repo }),
    ...(since === undefined ? {} : { since: parseSince(since, context.now) }),
    ...(parsed.values["--cursor"] === undefined ? {} : { cursor: parsed.values["--cursor"] }),
    ...(limit === undefined ? {} : { limit }),
    ...(verdict === undefined ? {} : { verdict: readVerdict(verdict) }),
    ...(parsed.values["--file"] === undefined ? {} : { file: parsed.values["--file"] }),
  };
}

function countBlock(rendered: RenderedItems, selection: SelectResult): StructuredOutput {
  return {
    matched: selection.matched,
    included: rendered.included,
    omitted: rendered.omitted,
    truncated: rendered.truncated,
    bytes: rendered.bytes,
    has_more: selection.hasMore || rendered.omitted > 0,
  };
}

/** The filters that were actually applied, echoed so a page is reproducible. */
function filterBlock(filters: ItemFilters): StructuredOutput {
  return Object.keys(filters).length === 0 ? {} : { filters };
}

function listHelp(rendered: RenderedItems, selection: SelectResult, defaultCut: boolean): string[] {
  const more = selection.hasMore || rendered.omitted > 0;
  const help = [HELP_SHOW, HELP_FORMATS];
  if (defaultCut) help.unshift(HELP_CAPS, HELP_BULK_FIELDS);
  if (more && rendered.cursor !== undefined) {
    help.unshift(`Run \`lightspeed feedback list --cursor ${rendered.cursor}\` for the next page`);
  }
  return help;
}

/** Zero rows is a definitive answer, not an empty format dump: even `--format
 * jsonl` gets the TOON state — a blank stdout says nothing about why. */
function emptyList(
  rendered: RenderedItems,
  selection: SelectResult,
  filters: ItemFilters,
): StructuredOutput {
  const budgetCut = selection.matched > 0;
  return {
    items: 0,
    count: countBlock(rendered, selection),
    ...filterBlock(filters),
    message: budgetCut
      ? "every matching item was larger than --max-bytes"
      : emptyMatchMessage(filters),
    help: budgetCut ? [HELP_BUDGET, HELP_SHOW] : [HELP_START, HELP_LIST],
  };
}

function emptyMatchMessage(filters: ItemFilters): string {
  return Object.keys(filters).length === 0
    ? "no feedback recorded yet"
    : "no feedback matches these filters";
}

function readVerdict(value: string): Verdict {
  const verdicts: readonly string[] = VERDICTS;
  if (!verdicts.includes(value)) {
    throw new ReviewError({
      code: "invalid_arguments",
      message: `--verdict expects one of ${VERDICTS.join(", ")}, got "${value}"`,
      detail: "unknown means no outcome has judged the item yet",
      suggestions: [HELP_LIST],
    });
  }
  return value as Verdict;
}
