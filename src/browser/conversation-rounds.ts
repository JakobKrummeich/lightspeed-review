import type { ConversationEntry, RoundMark } from "../session-store.ts";

export interface RoundSegment {
  round: number;
  current: boolean;
  entries: ConversationEntry[];
}

/**
 * Silent rounds get no segment, except the round on screen: an empty divider
 * there is exactly the news that everything above it is older than what the
 * reviewer sees.
 */
export function roundSegments(
  conversation: readonly ConversationEntry[],
  rounds: readonly RoundMark[],
): RoundSegment[] {
  if (conversation.length === 0) return [];
  const current = currentRound(rounds);
  const segments = grouped(conversation, rounds, current);
  if (segments.at(-1)?.current !== true) {
    segments.push({ round: current, current: true, entries: [] });
  }
  return segments;
}

/**
 * Exported because several places ask this (diff, pill stamps, live segment)
 * and two readings must not disagree.
 */
export function currentRound(rounds: readonly RoundMark[]): number {
  return rounds.at(-1)?.index ?? 0;
}

/**
 * Grouped by adjacency, not by key: shown in said order, and a clock that
 * stepped backwards must not reorder it.
 */
function grouped(
  conversation: readonly ConversationEntry[],
  rounds: readonly RoundMark[],
  current: number,
): RoundSegment[] {
  const segments: RoundSegment[] = [];
  for (const entry of conversation) {
    const round = roundOf(entry, rounds);
    const open = segments.at(-1);
    if (open !== undefined && open.round === round) open.entries.push(entry);
    else segments.push({ round, current: round === current, entries: [entry] });
  }
  return segments;
}

/**
 * The stamp, or (pre-stamp entries) the last round opened before it — exact,
 * since nothing said after a round's `at` belongs to an earlier round. A tie
 * goes to the older round: an entry sharing the boundary millisecond is usually
 * the feedback the agent acted on, which belongs with the diff it was about.
 * Exported: `commented-files.ts` asks the same question and must get the same answer.
 */
export function roundOf(entry: ConversationEntry, rounds: readonly RoundMark[]): number {
  if (entry.roundIndex !== undefined) return entry.roundIndex;
  const opened = rounds.findLast((round) => round.at < entry.at);
  // Older than every round, or no rounds at all: first round, index 0 by construction.
  return opened?.index ?? 0;
}
