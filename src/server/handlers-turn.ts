/**
 * The only endpoint gated on the turn, because it is the only one that claims
 * to hold it — speaking, waiting and ending are legal from either side.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionRecord } from "../session-store.ts";
import { turnHelp } from "../commands/home.ts";
import { agentWorking, budgetHelp, helpFormFor, turnFacts, turnLabel } from "../turn.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { badRequest, sendJson, type DomainErrorBody } from "./http.ts";
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
  // Before the turn, because an ended review has no turn to hold: the record
  // still names whoever held it last, and reading that first wrote a plan onto
  // an ended session — and told the agent it did not hold the turn. Answered the
  // way `reply` and `approved` answer, so one ended review reads the same from
  // every command.
  if (session.status === "ended") {
    sendJson(response, 409, {
      error: {
        code: "session_ended",
        message: "this review is ended; there is no silence left to declare",
      },
    });
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
  const spoken = budgetHelp(session);
  const updated: SessionRecord = {
    ...spoken.session,
    turn: agentWorking(now, plan),
    updatedAt: now,
  };
  context.store.save(updated);
  context.transport.publishPresence(session.key);
  sendJson(response, 200, { ...turnFacts(updated), helpForm: spoken.form, changed });
}

/**
 * An illegal move answered with the move that makes it legal. Structured rather
 * than prose because the agent reads failures the way it reads results, and the
 * fixing command names this session so nothing has to be guessed from the error.
 */
function turnRejection(session: SessionRecord): DomainErrorBody {
  return {
    error: {
      code: "turn_not_yours",
      message: `you do not hold the turn (turn: ${turnLabel(session)}) — nothing has been sent to you yet`,
      detail:
        "the turn moves to you when the reviewer's feedback is delivered to a blocking" +
        " `lightspeed wait`, and never before",
    },
    // The same list the commands print: a refusal must not name a move another
    // answer calls illegal. An ended review never reaches here — it is a 409.
    // Read short where the round has already spelt the moves out, but never
    // spent: a refusal is not the answer those tokens were for.
    help: turnHelp("reviewer", `${session.branch} ${session.base}`, helpFormFor(session)),
  };
}
