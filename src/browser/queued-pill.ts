import type { FeedbackPrompt } from "../session-store.ts";

/**
 * The stamp never travels: pills survive into a new round on purpose, but their
 * anchors point into the diff of the round they were selected from, and the
 * stamp is what lets the tray say so. The server already records which round a
 * prompt arrived in, so the wire format stays exactly `FeedbackPrompt`.
 * Optional because a pill stored before stamping existed has none.
 */
export type QueuedPill = FeedbackPrompt & { round?: number };

export function stampPills(prompts: readonly FeedbackPrompt[], round: number): QueuedPill[] {
  return prompts.map((prompt) => ({ ...prompt, round }));
}

export function unstampedPill(pill: QueuedPill): FeedbackPrompt {
  if (pill.round === undefined) return pill;
  const prompt = { ...pill };
  delete prompt.round;
  return prompt;
}

/** An unstamped pill is never called stale: absence of a stamp is absence of a claim. */
export function stalePillRound(pill: QueuedPill, current: number): number | undefined {
  if (pill.round === undefined || pill.round === current) return undefined;
  return pill.round;
}
