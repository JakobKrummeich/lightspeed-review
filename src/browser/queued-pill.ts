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

/**
 * An unstamped pill is never called stale: absence of a stamp is absence of a
 * claim. Only a line comment can be: the badge warns that lines may not line
 * up, and a message, reply or resolve has none — one queued through the
 * agent's turn outliving the round it was typed in is the ordinary case.
 */
export function stalePillRound(pill: QueuedPill, current: number): number | undefined {
  if (pill.type !== "annotation") return undefined;
  if (pill.round === undefined || pill.round === current) return undefined;
  return pill.round;
}

/**
 * What the queue holds, by kind: "your 1 comment stays queued" about a queued
 * reply read as a lost comment somewhere the reviewer never wrote one.
 */
export interface QueueTally {
  /** Line and general comments alike. */
  comments: number;
  replies: number;
  /** Resolve and reopen toggles alike. */
  resolves: number;
}

export const NOTHING_QUEUED: QueueTally = { comments: 0, replies: 0, resolves: 0 };

export function tallyOf(pills: readonly FeedbackPrompt[]): QueueTally {
  const count = (types: readonly FeedbackPrompt["type"][]): number =>
    pills.filter((pill) => types.includes(pill.type)).length;
  return {
    comments: count(["annotation", "message"]),
    replies: count(["reply"]),
    resolves: count(["resolve"]),
  };
}

export function queuedTotal(tally: QueueTally): number {
  return tally.comments + tally.replies + tally.resolves;
}
