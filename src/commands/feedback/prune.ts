import { ReviewError } from "../../errors.ts";
import { parseSince } from "../../ledger/export.ts";
import { prunePlan, type PrunePlan } from "../../ledger/prune.ts";
import type { LedgerRecord } from "../../ledger/records.ts";
import type { LedgerStore, RewriteResult } from "../../ledger/store.ts";
import type { StructuredOutput } from "../../output.ts";
import {
  HELP_LIST,
  HELP_PRUNE,
  HELP_PRUNE_DRY,
  HELP_PRUNE_FINAL,
  HELP_PRUNE_WET,
  parseArgs,
  readRepo,
  requireStore,
  type FeedbackContext,
} from "./shared.ts";

const PRUNE_FLAGS = ["--before", "--repo", "--dry-run"] as const;

/** The one destructive command, so it reports the same shape whether or not it
 * acts: the plan is computed before any file is touched; `--dry-run` stops there. */
export function pruneFeedback(args: string[], context: FeedbackContext): StructuredOutput {
  const parsed = parseArgs(args, PRUNE_FLAGS);
  const before = parsed.values["--before"];
  if (before === undefined) {
    throw new ReviewError({
      code: "invalid_arguments",
      message: "prune needs --before <date>",
      detail: "there is no default cutoff: pruning deletes records for good",
      suggestions: [HELP_PRUNE],
    });
  }
  const cutoff = parseSince(before, context.now);
  const repo = readRepo(parsed, context);
  const dryRun = parsed.present.has("--dry-run");
  const store = requireStore(context);
  const keep = (record: LedgerRecord) => record.at >= cutoff || !inRepo(record, repo);
  const plan = prunePlan(store.read({}).records, keep);
  const result = dryRun ? undefined : rewriteOrFail(store, keep);
  return {
    pruned: {
      dry_run: dryRun,
      path: store.path,
      before: cutoff,
      ...(repo === undefined ? {} : { repo }),
      removed: plan.removed,
      kept: plan.kept,
      items_removed: plan.itemsRemoved,
      ...removedSpan(plan),
      ...droppedCorrupt(result),
    },
    months: plan.months,
    ...(plan.removed === 0
      ? { message: `nothing is older than ${cutoff}, so nothing was deleted` }
      : {}),
    help: dryRun
      ? [HELP_PRUNE_WET, HELP_PRUNE_FINAL, HELP_LIST]
      : [HELP_PRUNE_FINAL, HELP_PRUNE_DRY, HELP_LIST],
  };
}

/** The range actually deleted, absent when the cutoff matched nothing. */
function removedSpan(plan: PrunePlan): { oldest_removed?: string; newest_removed?: string } {
  if (plan.oldestRemoved === undefined) return {};
  return { oldest_removed: plan.oldestRemoved, newest_removed: plan.newestRemoved };
}

/** Corrupt lines a rewrite could not carry over are reported, never counted as pruned. */
function droppedCorrupt(result: { corrupt: number } | undefined): { corrupt_dropped?: number } {
  if (result === undefined || result.corrupt === 0) return {};
  return { corrupt_dropped: result.corrupt };
}

function inRepo(record: LedgerRecord, repo: string | undefined): boolean {
  return repo === undefined || record.repo.root === repo;
}

/** The one ledger call that may fail loudly: a prune that silently kept everything
 * would be worse than an error. */
function rewriteOrFail(store: LedgerStore, keep: (record: LedgerRecord) => boolean): RewriteResult {
  try {
    return store.rewrite(keep);
  } catch (error) {
    throw new ReviewError({
      code: "ledger_unwritable",
      message: `could not rewrite the feedback ledger in ${store.path}`,
      detail: (error as Error).message,
      suggestions: [
        `Check the permissions on ${store.path}`,
        "Re-run the prune once the directory is writable; nothing was lost",
      ],
    });
  }
}
