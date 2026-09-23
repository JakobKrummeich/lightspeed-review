import type { IncomingMessage, ServerResponse } from "node:http";
import { drainPending, type PollPayload } from "../feedback.ts";
import { holdSocketOpen } from "../hold-open.ts";
import type { Delivery, FeedbackPrompt, SessionRecord } from "../session-store.ts";
import { turnHelp } from "../commands/home.ts";
import {
  agentReading,
  budgetHelp,
  helpFormFor,
  helpFormField,
  reviewerTurn,
  turnFacts,
  turnLabel,
  type HelpForm,
} from "../turn.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { badRequest, sendJson, type DomainErrorBody } from "./http.ts";
import type { Waker } from "./streams.ts";
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
 * No timeout and no heartbeat — the agent is expected to run `wait` in the
 * foreground and wait.
 */
export function handlePoll(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const key = context.requestUrl(request).searchParams.get("key") ?? undefined;
  const session = requireSession(context.store, response, key);
  if (!session) return;
  // Parking hands the turn back, so a `wait` from an agent that is still
  // editing would take the review off it. Refused before anything else here.
  if (session.turn.holder === "agent" && session.turn.mode === "working") {
    sendJson(response, 422, stillYours(session));
    return;
  }
  // An idle poll may wait for hours: no timer of this server's may close it,
  // and TCP keepalive keeps the connection known to both ends.
  holdSocketOpen(request.socket);
  if (deliverFeedback(context, session.key, response)) return;
  // Several agents may wait on one session; whoever loses the race to the
  // queue stays parked rather than being answered with nothing. Taking it is
  // what `true` says: the transport wakes the next one only if this one could not.
  const wake: Waker = (reason) => {
    if (reason === "feedback" && !deliverFeedback(context, session.key, response)) return false;
    context.transport.removePoller(session.key, wake);
    // A waiting agent must be told the wait is over, not handed an empty body.
    if (reason === "shutdown") {
      sendJson(response, 503, {
        error: { code: "server_stopped", message: "the review server shut down" },
      });
    }
    return true;
  };
  context.transport.addPoller(session.key, wake);
  // Parking hands the turn back: a lock that outlasted the work by a whole round
  // is exactly the stale Send this design exists to prevent. Done after the
  // poller is on the books, because the other order announced a waiterless
  // review for one frame — just as an agent arrived.
  handTurnBack(context, session.key);
  request.on("close", () => {
    context.transport.removePoller(session.key, wake);
    context.transport.publishPresence(session.key);
  });
}

/**
 * Idempotent and unauthenticated like every route here: an id that is not the
 * one in flight confirms nothing, which is what a retry of an already-confirmed
 * delivery looks like.
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
 *
 * Recovery runs here, immediately before the drain, and not on the way in: one
 * slot holds what is in flight, and a drain that ran without emptying it first
 * would overwrite a batch nobody has confirmed — leaving it in neither `pending`
 * nor `delivering`, which is the one way feedback is lost for good. A poll that
 * arrives and a parked poller that is woken both come through here, so neither
 * can be the path that forgets. The cost is that two agents that really are
 * both alive can be handed the same batch — a window one acknowledgement wide,
 * and at-least-once is the trade this whole mechanism is making.
 */
function deliverFeedback(context: ServerContext, key: string, response: ServerResponse): boolean {
  // Nothing is drained onto a socket that is already gone.
  if (response.socket === null || response.socket.destroyed) return false;
  recoverDelivery(context, key);
  const session = context.store.get(key);
  const drained = session && drainPending(session);
  if (!drained) return false;
  const now = new Date().toISOString();
  const handed = handOver(drained.session, drained.payload, now);
  const held = heldForConfirmation(context, drained.payload.prompts, now);
  context.store.save({ ...handed.session, ...held.record });
  // The turn as it stands after the handover, not before it: the answer is the
  // agent's proof that the review is now its move.
  sendJson(response, 200, {
    ...drained.payload,
    ...turnFacts(handed.session),
    ...helpFormField(handed.form),
    ...held.payload,
  });
  if (handsOverTurn(drained.payload)) context.transport.publishPresence(key);
  return true;
}

/**
 * A payload that hands nothing over is an ended review's account of what it
 * left — read once, acted on once, never shortened — so it takes no turn and
 * spends none of the round's help budget.
 */
function handOver(
  session: SessionRecord,
  payload: PollPayload,
  now: string,
): { form?: HelpForm; session: SessionRecord } {
  if (!handsOverTurn(payload)) return { session };
  const spoken = budgetHelp(session);
  return { form: spoken.form, session: { ...spoken.session, turn: agentReading(now) } };
}

/**
 * The field on the record and the id on the answer, minted together so they
 * cannot disagree. A payload carrying no prompts holds nothing — an ended
 * review with an empty queue has nothing to lose on the way out.
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
 * before anything sent since) for the drain that is about to run. The turn is
 * left alone: that drain either takes it again with the re-delivery, or the
 * poll parks and hands it back — no path out of here leaves it where the agent
 * that never read a word left it.
 *
 * Recovery happens on the next drain rather than when the connection closes,
 * because `close` always fires before the confirmation could arrive — it
 * travels on a second connection — so a close-triggered rollback would race
 * every healthy delivery and hand the same prompts out twice. An agent that
 * died holding an unconfirmed batch keeps it until something drains again,
 * which is the same recovery story as an agent that died holding the turn.
 */
function recoverDelivery(context: ServerContext, key: string): void {
  const session = context.store.get(key);
  if (session?.delivering === undefined) return;
  context.store.save({
    ...withoutDelivery(session),
    pending: [...session.delivering.prompts, ...session.pending],
  });
}

function withoutDelivery(session: SessionRecord): SessionRecord {
  const settled = { ...session };
  delete settled.delivering;
  return settled;
}

/**
 * Published even when the turn was already the reviewer's: the frame is also
 * how a page learns an agent has arrived on the wire.
 *
 * An agent that declared `work` never reaches here: that poll is refused with
 * `turn_still_yours` at the top of `handlePoll`, which runs to this call without
 * awaiting, so the mode cannot change in between. Re-checking it here would be a
 * second, quieter statement of that rule — and the one that would survive if the
 * 422 were ever deleted, stripping a working agent of its turn in silence.
 */
function handTurnBack(context: ServerContext, key: string): void {
  const session = context.store.get(key);
  if (session && session.turn.holder === "agent") {
    context.store.save({ ...session, turn: reviewerTurn(new Date().toISOString()) });
  }
  context.transport.publishPresence(key);
}

/**
 * Refused with the moves that are actually legal from here: publish the round
 * the work produced, or ask a question, both of which give the turn up
 * deliberately before they block. Those moves come from the same list the
 * commands print, so a refusal and a `help[]` can never disagree about what is
 * legal.
 */
function stillYours(session: SessionRecord): DomainErrorBody {
  return {
    error: {
      code: "turn_still_yours",
      message: `the turn is still yours (turn: ${turnLabel(session)}) — there is nothing to wait for`,
      detail:
        "you declared this work with `lightspeed work`, so the reviewer is waiting on you;" +
        " waiting here would hand them the turn while you are still editing",
    },
    help: turnHelp("agent working", `${session.branch} ${session.base}`, helpFormFor(session)),
  };
}
