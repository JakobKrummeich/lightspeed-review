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
 *
 * Counted in items, not pills: "Send 2" for a reply and a resolve on one
 * thread counted twice what the reviewer did once. Every new comment is an
 * item; every existing thread touched is one, however many pills went into
 * it. Summed, the kinds are `batchSize` in `src/threads.ts`, the number the
 * agent is handed and every queue count on the page shows.
 */
export interface QueueTally {
  /** Line and general comments alike: each opens a thread of its own. */
  comments: number;
  /** Threads holding at least one queued reply, resolved as well or not. */
  replies: number;
  /** Threads only resolved or reopened: toggles alike, and no words. */
  resolves: number;
}

export const NOTHING_QUEUED: QueueTally = { comments: 0, replies: 0, resolves: 0 };

/** A thread with a reply and a resolve is named for its words: they are what the agent answers. */
export function tallyOf(pills: readonly FeedbackPrompt[]): QueueTally {
  const threadsOf = (type: "reply" | "resolve"): Set<string> =>
    new Set(pills.flatMap((pill) => (pill.type === type ? [pill.thread] : [])));
  const replied = threadsOf("reply");
  const onlyResolved = [...threadsOf("resolve")].filter((thread) => !replied.has(thread));
  return {
    comments: pills.filter((pill) => pill.type === "annotation" || pill.type === "message").length,
    replies: replied.size,
    resolves: onlyResolved.length,
  };
}

export function queuedTotal(tally: QueueTally): number {
  return tally.comments + tally.replies + tally.resolves;
}
