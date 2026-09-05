/**
 * The two live connections: the browser's SSE event stream and the agent's
 * long poll. Both register with `SessionTransport`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { drainPending } from "../feedback.ts";
import { holdSocketOpen } from "../hold-open.ts";
import type { FeedbackPrompt } from "../session-store.ts";
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
 * the agent is expected to run `poll` in the foreground and wait.
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
  // A parked agent is done with the last feedback even if it skipped the reply;
  // saying "working" would outlast the work by a whole round. Said after the
  // poller is on the books: `setWorking` publishes presence itself, and the other
  // order announced a waiterless review for one frame — just as an agent arrived.
  context.transport.setWorking(session.key, false);
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
  context.store.save(drained.session);
  response.on("close", () => {
    if (!response.writableFinished) requeue(context, key, drained.payload.prompts);
  });
  sendJson(response, 200, drained.payload);
  // Agent is off acting on the reviewer's words — the banner says so. An ended
  // review or a promptless payload is not work anybody is doing.
  if (drained.payload.prompts.length > 0 && !drained.payload.ended) {
    context.transport.setWorking(key, true);
  }
  return true;
}

/**
 * Drained prompts whose bytes never landed, put back at the head of the queue
 * (written order, before anything sent since) and offered to whoever waits now.
 */
function requeue(context: ServerContext, key: string, prompts: FeedbackPrompt[]): void {
  // The agent that took the prompts is gone: nobody works this review until another poll.
  context.transport.setWorking(key, false);
  const session = context.store.get(key);
  if (!session || prompts.length === 0) return;
  context.store.save({ ...session, pending: [...prompts, ...session.pending] });
  context.transport.wakePollers(key);
}
