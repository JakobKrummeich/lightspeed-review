import type { FeedbackLogMode } from "../config.ts";
import { validationError } from "../errors.ts";
import { repoRows, selectItems, verdictCounts, type ExportItem } from "../ledger/export.ts";
import { ledgerFor, type LedgerReadResult } from "../ledger/store.ts";
import type { StructuredOutput } from "../output.ts";
import { feedbackDirPath } from "../paths.ts";
import { listFeedback } from "./feedback/list.ts";
import { pruneFeedback } from "./feedback/prune.ts";
import {
  HELP_ENABLE,
  HELP_LIST,
  HELP_PRUNE,
  HELP_SHOW,
  unknownFlag,
  type FeedbackContext,
} from "./feedback/shared.ts";
import { showFeedback } from "./feedback/show.ts";
import { HELP_START } from "./home.ts";

/** The mining agent's read command: whole-ledger summary, filtered list, one item
 * in full, prune. Everything printed comes from `ledger/export.ts` — command files
 * only parse flags, shape output and compose `help[]`. This file dispatches and
 * answers the bare summary; subcommands live in `feedback/` on `feedback/shared.ts`. */
export interface FeedbackInput {
  args: string[];
  /** What `--repo .` resolves to. Absent when run outside a repository, which is
   * allowed: the ledger spans repositories. */
  repoRoot?: string;
  stateDir: string;
  feedbackLog: FeedbackLogMode;
  /** Injected so `--since 30d` and `--before 30d` are testable. */
  now?: Date;
}

type Subcommand = (args: string[], context: FeedbackContext) => StructuredOutput | string;

const SUBCOMMANDS = {
  list: listFeedback,
  show: showFeedback,
  prune: pruneFeedback,
} as const satisfies Record<string, Subcommand>;

type SubcommandName = keyof typeof SUBCOMMANDS;

/** Exported so a test can prove every registered subcommand runs and is helped. */
export const FEEDBACK_SUBCOMMANDS = Object.keys(SUBCOMMANDS) as SubcommandName[];

export function runFeedback(input: FeedbackInput): StructuredOutput | string {
  const context: FeedbackContext = {
    store: ledgerFor(input.feedbackLog, input.stateDir),
    path: feedbackDirPath(input.stateDir),
    repoRoot: input.repoRoot,
    now: input.now ?? new Date(),
  };
  const [name, ...rest] = input.args;
  if (name === undefined) return summary(context);
  if (name.startsWith("-")) throw unknownFlag(name, FEEDBACK_SUBCOMMANDS);
  if (!Object.hasOwn(SUBCOMMANDS, name)) throw unknownSubcommand(name);
  return SUBCOMMANDS[name as SubcommandName](rest, context);
}

/** The bare command has three states — off, empty, populated — and no flags. */
function summary(context: FeedbackContext): StructuredOutput {
  if (context.store === undefined) return disabledSummary(context.path);
  const read = context.store.read({});
  const items = selectItems(read.records, {}).items;
  if (items.length === 0) return emptySummary(context.path, read.records.length);
  return populatedSummary(context.path, items, read);
}

function disabledSummary(path: string): StructuredOutput {
  return {
    ledger: { path, status: "off" },
    items: 0,
    message: "the feedback ledger is off in .lightspeed.conf.json",
    help: [HELP_ENABLE, HELP_START],
  };
}

/** Records without items means rounds happened but nobody commented yet. */
function emptySummary(path: string, records: number): StructuredOutput {
  return {
    ledger: { path, status: "on", records },
    items: 0,
    message: "no feedback recorded yet",
    help: [HELP_START, HELP_LIST],
  };
}

/** Aggregates are precomputed here so an agent never sums rows itself. */
function populatedSummary(
  path: string,
  items: ExportItem[],
  read: LedgerReadResult,
): StructuredOutput {
  const verdicts = verdictCounts(items);
  const repos = repoRows(items);
  return {
    ledger: {
      path,
      status: "on",
      records: read.records.length,
      items: items.length,
      repos: repos.length,
      first: items[0]!.at,
      last: items.at(-1)!.at,
      unresolved: verdicts.unresolved,
      ...(read.corrupt === 0 ? {} : { corrupt: read.corrupt }),
    },
    verdicts,
    repos,
    help: [HELP_LIST, HELP_SHOW, HELP_PRUNE],
  };
}

function unknownSubcommand(name: string) {
  return validationError(`unknown feedback subcommand ${name}`, [
    `Known subcommands: ${FEEDBACK_SUBCOMMANDS.join(", ")}`,
    "Run `lightspeed feedback` for the ledger summary",
  ]);
}
