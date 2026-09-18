/**
 * `lightspeed work "<plan>"`: the agent declaring the silence it is about to
 * keep. The only endpoint gated on the turn, because it is the only one that
 * claims to hold it — speaking, waiting and ending are legal from either side.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRecord } from "../session-store.ts";
import { agentWorking, turnFacts, turnLabel } from "../turn.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { badRequest, sendJson } from "./http.ts";
import { readWork } from "./validate.ts";

export async function handleWork(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const plan = await readWork(request);
  if (plan === undefined) {
    badRequest(response, "expected JSON {plan: string}");
    return;
  }
  if (session.turn.holder !== "agent") {
    sendJson(response, 422, turnRejection(session));
    return;
  }
  const now = new Date().toISOString();
  // Redeclaring is a no-op that still rewrites the note: an agent that says the
  // same thing twice has changed nothing, and one that refines its plan has.
  const changed = session.turn.mode !== "working" || session.turn.note !== plan;
  const updated: SessionRecord = { ...session, turn: agentWorking(now, plan), updatedAt: now };
  context.store.save(updated);
  context.transport.publishPresence(session.key);
  sendJson(response, 200, { ...turnFacts(updated), changed });
}

/**
 * An illegal move answered with the move that makes it legal. Structured rather
 * than prose because the agent reads failures the way it reads results, and the
 * fixing command names this session so nothing has to be guessed from the error.
 */
function turnRejection(session: SessionRecord): unknown {
  const target = `${session.branch} ${session.base}`;
  const ended = session.status === "ended";
  return {
    error: {
      code: "turn_not_yours",
      message: ended
        ? "this review is ended, so there is no turn to take"
        : `you do not hold the turn (turn: ${turnLabel(session)}) — nothing has been sent to you yet`,
      detail:
        "the turn moves to you when the reviewer's feedback is delivered to a blocking" +
        " `lightspeed wait`, and never before",
    },
    help: ended
      ? [
          `Only the reviewer reopens a review: run \`lightspeed start ${target} --reopen\` when they ask for a new round`,
        ]
      : [`Run \`lightspeed wait ${target}\` to block until the reviewer sends`],
  };
}
