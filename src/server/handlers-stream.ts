import type { IncomingMessage, ServerResponse } from "node:http";
import { batchPayload, endedPayload } from "../feedback.ts";
import { holdSocketOpen } from "../hold-open.ts";
import { withAck, withDelivery } from "../turn-moves.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { badRequest, sendJson } from "./http.ts";
import type { Waker } from "./streams.ts";
import { stillWorking } from "./turn-refusals.ts";
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
 * Whether anyone will receive the reviewer's Send: what bare `lightspeed` asks
 * before it tells an agent to start a wait that may already be running.
 */
export function handlePresence(
  context: ServerContext,
  _request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  sendJson(response, 200, { waiting: context.transport.isWaiting(session.key) });
}

/**
 * Waiting for the reviewer's Send — what `open`, `reply` and `publish` do once
 * they have posted. No timeout and no heartbeat: the agent runs them in the
 * foreground and waits. Parking moves no turn; only a delivery does.
 */
export function handlePoll(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const key = context.requestUrl(request).searchParams.get("key") ?? undefined;
  const session = requireSession(context.store, response, key);
  if (!session) return;
  // Waiting is a turn handed back, and a working agent has not handed it
  // back: the edits it is making are what the reviewer is waiting for.
  if (
    session.status !== "ended" &&
    session.turn.holder === "agent" &&
    session.turn.mode === "working"
  ) {
    sendJson(
      response,
      422,
      stillWorking(session, "the reviewer is waiting on the round your work opens"),
    );
    return;
  }
  // An idle poll may wait for hours: no timer of this server's may close it,
  // and TCP keepalive keeps the connection known to both ends.
  holdSocketOpen(request.socket);
  if (answer(context, session.key, response)) return;
  // Several agents may wait on one session; whoever loses the race to the
  // queue stays parked rather than being answered with nothing. Taking it is
  // what `true` says: the transport wakes the next one only if this one could not.
  const wake: Waker = (reason) => {
    if (reason === "feedback" && !deliver(context, session.key, response)) return false;
    context.transport.removePoller(session.key, wake);
    // A waiting agent must be told the wait is over, not handed an empty body.
    if (reason === "shutdown") {
      sendJson(response, 503, {
        error: { code: "server_stopped", message: "the review server shut down" },
      });
    }
    if (reason === "superseded") sendJson(response, 200, SUPERSEDED);
    return true;
  };
  context.transport.addPoller(session.key, wake);
  context.transport.publishPresence(session.key);
  request.on("close", () => {
    context.transport.removePoller(session.key, wake);
    context.transport.publishPresence(session.key);
  });
}

/**
 * Not an error: the command that took over is the agent's own, and the one
 * answered here has nothing left to do but exit.
 */
const SUPERSEDED = {
  superseded: true,
  message: "another lightspeed command took over listening for this review; nothing to do here",
};

/**
 * A poll that finds the agent already digesting is a waiting command re-run
 * after it was killed: it is handed the batch it holds again, never a second
 * one. Only on arrival — a parked poller woken later is a fresh delivery or
 * nothing, or two waiting agents would both be handed one batch.
 */
function answer(context: ServerContext, key: string, response: ServerResponse): boolean {
  const session = context.store.get(key);
  if (session?.status !== "ended" && session?.turn.holder === "agent") {
    sendJson(response, 200, batchPayload(session));
    return true;
  }
  return deliver(context, key, response);
}

/**
 * Answers a poll if the session has something to say; false = keep waiting.
 * The queue becomes the batch before the write, so two pollers cannot both be
 * handed it; the batch stays on the record, so a lost answer is recovered by
 * re-running the command — which re-attaches through `answer`.
 */
function deliver(context: ServerContext, key: string, response: ServerResponse): boolean {
  // Nothing is drained onto a socket that is already gone.
  if (response.socket === null || response.socket.destroyed) return false;
  const session = context.store.get(key);
  if (session === undefined) return false;
  if (session.status === "ended") {
    const ended = endedPayload(session);
    context.store.save(ended.session);
    sendJson(response, 200, ended.payload);
    return true;
  }
  if (session.turn.holder !== "reviewer" || session.pending.length === 0) return false;
  const now = new Date().toISOString();
  const delivered = withDelivery(session, context.nextId("evt", now), now);
  context.store.save(delivered);
  sendJson(response, 200, batchPayload(delivered));
  context.transport.publishPresence(key);
  return true;
}

/**
 * Idempotent and unauthenticated like every route here: an id that is not the
 * batch on record confirms nothing, which is what a retried ack looks like.
 */
export async function handleDelivered(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const delivery = await readDelivered(request);
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  if (delivery === undefined) {
    badRequest(response, "expected JSON {delivery: string}");
    return;
  }
  const acked = withAck(session, delivery);
  if (acked !== undefined) context.store.save(acked);
  sendJson(response, 200, { confirmed: session.batch?.id === delivery });
}
