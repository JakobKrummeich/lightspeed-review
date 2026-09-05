import type { LedgerRecord } from "./records.ts";

/**
 * The arithmetic of a prune, apart from the deleting: which records a cutoff
 * removes, bucketed by the month files the store keeps on disk. The command
 * prints this plan whether or not it goes on to rewrite, which is what makes
 * `--dry-run` trustworthy.
 */

/** How a month file ends up after the rewrite, named from the file's point of view. */
export type MonthFate = "deleted" | "rewritten" | "kept";

export interface MonthRow {
  month: string;
  removed: number;
  kept: number;
  file: MonthFate;
}

export interface PrunePlan {
  removed: number;
  kept: number;
  /** Annotations only: the reviewer comments a person would miss, not the plumbing. */
  itemsRemoved: number;
  oldestRemoved: string | undefined;
  newestRemoved: string | undefined;
  months: MonthRow[];
}

/**
 * Read from the same records `rewrite` will walk, so a dry run and the real
 * prune cannot disagree, and the per-month rows mirror the files on disk.
 */
export function prunePlan(
  records: LedgerRecord[],
  keep: (record: LedgerRecord) => boolean,
): PrunePlan {
  const months = new Map<string, MonthRow>();
  const removed: LedgerRecord[] = [];
  let kept = 0;
  for (const record of records) {
    const month = record.at.slice(0, 7);
    const row = months.get(month) ?? { month, removed: 0, kept: 0, file: "kept" };
    if (keep(record)) {
      row.kept += 1;
      kept += 1;
    } else {
      row.removed += 1;
      removed.push(record);
    }
    months.set(month, row);
  }
  const rows = [...months.values()].sort((left, right) => left.month.localeCompare(right.month));
  for (const row of rows) row.file = monthFate(row);
  const times = removed.map((record) => record.at).sort();
  return {
    removed: removed.length,
    kept,
    itemsRemoved: removed.filter((record) => record.kind === "annotation").length,
    oldestRemoved: times[0],
    newestRemoved: times.at(-1),
    months: rows,
  };
}

function monthFate(row: MonthRow): MonthFate {
  if (row.removed === 0) return "kept";
  return row.kept === 0 ? "deleted" : "rewritten";
}
