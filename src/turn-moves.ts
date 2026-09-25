/**
 * The v3 turn machine as pure record transitions: delivery takes the turn,
 * `reply` and `publish` hand it back, and a re-run of either is recognised
 * instead of posted twice. The handlers only read, call one of these and save.
 */
import { createHash } from "node:crypto";
import type { Handback, SessionRecord } from "./session-types.ts";
import { agentDigesting, reviewerTurn } from "./turn.ts";

/**
 * Everything the reviewer queued becomes the batch the agent now holds. Kept on
 * the record after delivery (see `Batch`), unacknowledged until the agent's CLI
 * says it arrived.
 */
export function withDelivery(session: SessionRecord, id: string, now: string): SessionRecord {
  return {
    ...session,
    pending: [],
    batch: { id, prompts: session.pending, at: now, acked: false },
    turn: agentDigesting(now),
    updatedAt: now,
  };
}

/** A stale or invented id confirms nothing, which is what a retried ack looks like. */
export function withAck(session: SessionRecord, id: string): SessionRecord | undefined {
  if (session.batch?.id !== id || session.batch.acked === true) return undefined;
  return { ...session, batch: { ...session.batch, acked: true } };
}

/** Same verb, same words: the server's only way to recognise a re-run command. */
export function fingerprintOf(verb: Handback["verb"], content: unknown): string {
  return createHash("sha256")
    .update(`${verb}\0${JSON.stringify(content)}`)
    .digest("hex");
}

/**
 * A re-run, not a new command: the same words handed back while the agent
 * has not provably read anything since — either no batch has been delivered
 * since, or the one that was never arrived (unacked). An agent that read a new
 * batch and happens to answer it in the same words is saying it again.
 */
export function isRerun(session: SessionRecord, handback: Handback): boolean {
  const last = session.lastHandback;
  if (last?.verb !== handback.verb || last.fingerprint !== handback.fingerprint) return false;
  return last.batch === session.batch?.id || session.batch?.acked !== true;
}

export function handbackOf(
  session: SessionRecord,
  verb: Handback["verb"],
  content: unknown,
): Handback {
  const batch = session.batch?.id;
  return {
    verb,
    fingerprint: fingerprintOf(verb, content),
    ...(batch === undefined ? {} : { batch }),
  };
}

/** The turn goes back to the reviewer, remembering the command that gave it. */
export function withHandback(
  session: SessionRecord,
  handback: Handback,
  now: string,
): SessionRecord {
  return { ...session, turn: reviewerTurn(now), lastHandback: handback, updatedAt: now };
}
