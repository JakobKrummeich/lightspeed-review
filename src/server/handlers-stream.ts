/**
 * The two live connections: the browser's SSE event stream and the agent's
 * long poll. Both register with `SessionTransport`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { drainPending, type PollPayload } from "../feedback.ts";
import { holdSocketOpen } from "../hold-open.ts";
import type { Delivery, FeedbackPrompt, SessionRecord } from "../session-store.ts";
import { agentReading, reviewerTurn, turnFacts } from "../turn.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { badRequest, sendJson } from "./http.ts";
import type { WakeReason } from "./streams.ts";
import { readDelivered } from "./validate.ts";

export function handleEvents(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(": connected\n\n");
  context.transport.subscribe(session.key, response);
  request.on("close", () => {
    context.transport.unsubscribe(session.key, response);
  });
}

/**
 * Long-poll: blocks until the reviewer sends. No timeout and no heartbeat —
 * the agent is expected to run `wait` in the foreground and wait.
 */
export function handlePoll(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const key = context.requestUrl(request).searchParams.get("key") ?? undefined;
  const session = requireSession(context.store, response, key);
  if (!session) return;
  // An idle poll may wait for hours: no timer of this server's may close it,
  // and TCP keepalive keeps the connection known to both ends.
  holdSocketOpen(request.socket);
  // A fresh poll is the proof that the last handover was not read: an agent
  // holding those prompts would be acting on them, not asking again.
  recoverDelivery(context, session.key);
  if (deliverFeedback(context, session.key, response)) return;
  // Several agents may wait on one session; whoever loses the race to the
  // queue stays parked rather than being answered with nothing.
  const wake = (reason: WakeReason) => {
    if (reason === "feedback" && !deliverFeedback(context, session.key, response)) return;
    context.transport.removePoller(session.key, wake);
    // A waiting agent must be told the wait is over, not handed an empty body.
    if (reason === "shutdown") {
      sendJson(response, 503, {
        error: { code: "server_stopped", message: "the review server shut down" },
      });
    }
  };
  context.transport.addPoller(session.key, wake);
  // Parking is the agent handing the turn back: it is listening, not editing,
  // and a lock that outlasted the work by a whole round is exactly the stale
  // Send this design exists to prevent. Done after the poller is on the books,
  // because the other order announced a waiterless review for one frame — just
  // as an agent arrived.
  handTurnBack(context, session.key);
  request.on("close", () => {
    context.transport.removePoller(session.key, wake);
    context.transport.publishPresence(session.key);
  });
}

/**
 * The agent confirming it read a handover. Idempotent and unauthenticated like
 * every route here: an id that is not the one in flight confirms nothing, which
 * is what a retry of an already-confirmed delivery looks like.
 */
export async function handleDelivered(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const delivery = await readDelivered(request);
  if (delivery === undefined) {
    badRequest(response, "expected JSON {delivery: string}");
    return;
  }
  const confirmed = session.delivering?.id === delivery;
  if (confirmed) context.store.save(withoutDelivery(session));
  sendJson(response, 200, { confirmed });
}

/**
 * Answers a poll if the session has something to say; false = keep waiting.
 * Drained before the write so two pollers cannot get the same prompts, and held
 * in `delivering` until the agent says it read them — the write landing proves
 * only that the kernel took the bytes, never that anybody was there to read.
 */
function deliverFeedback(context: ServerContext, key: string, response: ServerResponse): boolean {
  // Nothing is drained onto a socket that is already gone.
  if (response.socket === null || response.socket.destroyed) return false;
  const session = context.store.get(key);
  const drained = session && drainPending(session);
  if (!drained) return false;
  const now = new Date().toISOString();
  const handedOver = handsOverTurn(drained.payload);
  const saved: SessionRecord = handedOver
    ? { ...drained.session, turn: agentReading(now) }
    : drained.session;
  const held = heldForConfirmation(context, drained.payload.prompts, now);
  context.store.save({ ...saved, ...held.record });
  // The turn as it stands after the handover, not before it: the answer is the
  // agent's proof that the review is now its move.
  sendJson(response, 200, { ...drained.payload, ...turnFacts(saved), ...held.payload });
  if (handedOver) context.transport.publishPresence(key);
  return true;
}

/**
 * The batch held until the agent confirms it, as the two things it adds: the
 * field on the record and the id on the answer, minted together so they cannot
 * disagree. A payload carrying no prompts holds nothing — an ended review with
 * an empty queue has nothing to lose on the way out.
 */
function heldForConfirmation(
  context: ServerContext,
  prompts: FeedbackPrompt[],
  now: string,
): { record: Pick<SessionRecord, "delivering">; payload: { delivery?: string } } {
  if (prompts.length === 0) return { record: {}, payload: {} };
  const delivering: Delivery = { id: context.nextId("evt", now), prompts, at: now };
  return { record: { delivering }, payload: { delivery: delivering.id } };
}

/**
 * Delivery is the one move that takes the turn, and it happens here rather than
 * on the reviewer's Send: words nobody was waiting for stay queued and the
 * reviewer keeps sending. An ended review or a promptless payload hands nothing
 * over, so it takes nothing.
 */
function handsOverTurn(payload: PollPayload): boolean {
  return payload.prompts.length > 0 && !payload.ended;
}

/**
 * An unconfirmed handover put back at the head of the queue (written order,
 * before anything sent since) for the poll that is asking now. The turn is left
 * alone: this poll either takes it again with the re-delivery that follows, or
 * parks and hands it back — no path out of here leaves it where the agent that
 * never read a word left it.
 *
 * Recovery happens on the next poll rather than when the connection closes,
 * because `close` always fires before the confirmation could arrive — it
 * travels on a second connection — so a close-triggered rollback would race
 * every healthy delivery and hand the same prompts out twice. An agent that
 * died holding an unconfirmed batch keeps it until something polls again, which
 * is the same recovery story as an agent that died holding the turn.
 */
function recoverDelivery(context: ServerContext, key: string): void {
  const session = context.store.get(key);
  if (session?.delivering === undefined) return;
  context.store.save({
    ...withoutDelivery(session),
    pending: [...session.delivering.prompts, ...session.pending],
  });
}

/** The record with nothing in flight, spelt once so no writer leaves a stale batch. */
function withoutDelivery(session: SessionRecord): SessionRecord {
  const settled = { ...session };
  delete settled.delivering;
  return settled;
}

/**
 * The turn back to the reviewer, published even when it was already theirs: the
 * frame is also how a page learns an agent has arrived on the wire.
 */
function handTurnBack(context: ServerContext, key: string): void {
  const session = context.store.get(key);
  if (session && session.turn.holder === "agent") {
    context.store.save({ ...session, turn: reviewerTurn(new Date().toISOString()) });
  }
  context.transport.publishPresence(key);
}
