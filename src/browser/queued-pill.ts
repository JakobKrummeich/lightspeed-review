import type { FeedbackPrompt } from "../session-store.ts";

/**
 * A prompt queued in the browser, stamped with the round it was queued in. The
 * stamp never travels: pills survive into a new round on purpose, but their
 * anchors point into the diff of the round they were selected from, and the
 * stamp is what lets the tray say so. The server already records which round a
 * prompt arrived in, so the wire format stays exactly `FeedbackPrompt`.
 *
 * The stamp is optional because a pill stored before stamping existed has
 * none, and absence must read as "no claim" — never as any particular round.
 */
export type QueuedPill = FeedbackPrompt & { round?: number };

/** The prompts just queued, each stamped with the round on screen. */
export function stampPills(prompts: readonly FeedbackPrompt[], round: number): QueuedPill[] {
  return prompts.map((prompt) => ({ ...prompt, round }));
}

/** The prompt as the wire expects it, with the page's own stamp taken back off. */
export function unstampedPill(pill: QueuedPill): FeedbackPrompt {
  if (pill.round === undefined) return pill;
  const prompt = { ...pill };
  delete prompt.round;
  return prompt;
}

/**
 * The round a pill was queued in, when that is no longer the round on screen —
 * which is when its anchor may no longer line up with the diff. An unstamped
 * pill is never called stale: absence of a stamp is absence of a claim.
 */
export function stalePillRound(pill: QueuedPill, current: number): number | undefined {
  if (pill.round === undefined || pill.round === current) return undefined;
  return pill.round;
}
