import type { RoundMark } from "../session-store.ts";

/** Anything said at a moment, possibly stamped with the round it was said in. */
export interface Placed {
  at: string;
  roundIndex?: number;
}

/**
 * Exported because several places ask this (diff, pill stamps, the panel)
 * and two readings must not disagree.
 */
export function currentRound(rounds: readonly RoundMark[]): number {
  return rounds.at(-1)?.index ?? 0;
}

/**
 * The stamp, or (pre-stamp entries) the last round opened before it — exact,
 * since nothing said after a round's `at` belongs to an earlier round. A tie
 * goes to the older round: an entry sharing the boundary millisecond is usually
 * the feedback the agent acted on, which belongs with the diff it was about.
 * Exported: `commented-files.ts` asks the same question and must get the same answer.
 */
export function roundOf(entry: Placed, rounds: readonly RoundMark[]): number {
  if (entry.roundIndex !== undefined) return entry.roundIndex;
  const opened = rounds.findLast((round) => round.at < entry.at);
  // Older than every round, or no rounds at all: first round, index 0 by construction.
  return opened?.index ?? 0;
}
