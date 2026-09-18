/**
 * The two live connections: the browser's SSE event stream and the agent's
 * long poll. Both register with `SessionTransport`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { drainPending, type PollPayload } from "../feedback.ts";
import { holdSocketOpen } from "../hold-open.ts";
import type { FeedbackPrompt } from "../session-store.ts";
import { agentReading, reviewerTurn } from "../turn.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { sendJson } from "./http.ts";
import type { WakeReason } from "./streams.ts";

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
 * Answers a poll if the session has something to say; false = keep waiting.
 * Drained before the write so two pollers cannot get the same prompts; put back
 * if the write never lands, so a reconnecting agent still finds the feedback.
 */
function deliverFeedback(context: ServerContext, key: string, response: ServerResponse): boolean {
  // A socket already gone never emits `close` again, so the rollback below
  // would never run for it. Nothing is drained onto one.
  if (response.socket === null || response.socket.destroyed) return false;
  const session = context.store.get(key);
  const drained = session && drainPending(session);
  if (!drained) return false;
  const handedOver = handsOverTurn(drained.payload);
  context.store.save(
    handedOver
      ? { ...drained.session, turn: agentReading(new Date().toISOString()) }
      : drained.session,
  );
  response.on("close", () => {
    if (!response.writableFinished) requeue(context, key, drained.payload.prompts);
  });
  sendJson(response, 200, drained.payload);
  if (handedOver) context.transport.publishPresence(key);
  return true;
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
 * Drained prompts whose bytes never landed, put back at the head of the queue
 * (written order, before anything sent since) and offered to whoever waits now.
 * The turn rolls back with them: the agent that took them never read a word.
 */
function requeue(context: ServerContext, key: string, prompts: FeedbackPrompt[]): void {
  const session = context.store.get(key);
  if (!session || prompts.length === 0) return;
  context.store.save({
    ...session,
    pending: [...prompts, ...session.pending],
    turn: reviewerTurn(new Date().toISOString()),
  });
  context.transport.publishPresence(key);
  context.transport.wakePollers(key);
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
