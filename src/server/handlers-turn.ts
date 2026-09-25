/**
 * `lightspeed work`: the discussion is over and the agent starts changing code.
 * It hands nothing back and waits for nothing, so it is the one turn move that
 * returns at once.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentTurn, SessionRecord } from "../session-types.ts";
import { openIds } from "../threads.ts";
import { agentWorking, turnFacts } from "../turn.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { badRequest, sendJson } from "./http.ts";
import { reviewerHolds } from "./turn-refusals.ts";
import { readWork } from "./validate.ts";

export async function handleWork(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const work = await readWork(request);
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  if (work === undefined) {
    badRequest(response, "expected JSON {plan: string, head?: string}");
    return;
  }
  const turn = workableTurn(session, response);
  if (!turn) return;
  const now = new Date().toISOString();
  // Redeclaring rewrites the plan and keeps the HEAD the work started from:
  // that HEAD is what a later `reply` from working is measured against.
  const changed = turn.mode !== "working" || turn.note !== work.plan;
  const found = turn.mode === "working" ? { head: turn.head, tree: turn.tree } : work;
  const updated: SessionRecord = {
    ...session,
    turn: agentWorking(now, work.plan, found),
    updatedAt: now,
  };
  context.store.save(updated);
  context.transport.publishPresence(session.key);
  // The ids the agent's `publish --to` may name: it has the batch, not the thread list.
  const open = openIds(updated.conversation, updated.batch?.prompts);
  sendJson(response, 200, { ...turnFacts(updated), changed, open });
}

/**
 * Ended before the turn, because an ended review has no turn to hold: the record
 * still names whoever held it last, and reading that first wrote a plan onto an
 * ended session — and told the agent it did not hold the turn. Answered the way
 * `reply` and `approved` answer, so one ended review reads the same from every
 * command.
 */
function workableTurn(session: SessionRecord, response: ServerResponse): AgentTurn | undefined {
  if (session.status === "ended") {
    sendJson(response, 409, {
      error: {
        code: "session_ended",
        message: "this review is ended; there is no turn left to work in",
      },
    });
    return undefined;
  }
  if (session.turn.holder === "agent") return session.turn;
  sendJson(response, 422, reviewerHolds(session, "work"));
  return undefined;
}
