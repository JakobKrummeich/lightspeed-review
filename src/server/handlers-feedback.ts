/**
 * The conversation endpoints: the reviewer's approvals and feedback in, the
 * agent's reply back. Everything here writes the store first and the ledger
 * second, so a broken ledger never changes an answer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { validateDeclarations, withDeclarations } from "../declarations.ts";
import { withAgentReply, withFeedback } from "../feedback.ts";
import { listDiffNames } from "../git-file.ts";
import { reviewPaths } from "../review-files.ts";
import { withClosedRound } from "../rounds/session-round.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { announceRoundEnd } from "./handlers-session.ts";
import { badRequest, sendJson } from "./http.ts";
import { logAgentReply, logDeclarations, logFeedback } from "./ledger-log.ts";
import { declarationRejection, parseApproved, readFeedback, readReply } from "./validate.ts";

export async function handleApproved(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const posted = await parseApproved(request);
  if (!posted) {
    badRequest(response, "expected JSON {approved: string[]}");
    return;
  }
  // A tick after `end` would rewrite the ledgered verdict.
  if (session.status === "ended") {
    sendJson(response, 409, {
      error: {
        code: "session_ended",
        message: "this review is ended; its approvals are what the reviewer left",
      },
    });
    return;
  }
  // Only paths in this round's grouping: stale or invented paths would skew the counters.
  const known = reviewPaths(session.groups);
  const approved = posted.filter((path) => known.has(path));
  context.store.save({ ...session, approved, updatedAt: new Date().toISOString() });
  sendJson(response, 200, { approved });
}

export async function handleFeedback(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const feedback = await readFeedback(request);
  if (!feedback) {
    badRequest(response, "expected JSON {prompts: [{type, comment, ...}], ended: bool}");
    return;
  }
  const now = new Date().toISOString();
  // Ids minted here, not in the ledger writer: they must exist with the ledger off.
  const prompts = feedback.prompts.map((prompt) =>
    prompt.type === "annotation" ? { ...prompt, id: context.nextId("evt", now) } : prompt,
  );
  const updated = withFeedback(session, { ...feedback, prompts }, now);
  context.store.save(feedback.ended ? withClosedRound(updated) : updated);
  logFeedback(context.log, session, prompts, now);
  context.transport.wakePollers(session.key);
  context.transport.publish(session.key, "feedback", { queued: prompts.length });
  // "Send & End" is the reviewer closing the round, so it closes like one.
  if (feedback.ended) announceRoundEnd(context, session, now);
  sendJson(response, 200, { queued: feedback.prompts.length });
}

export async function handleAgentReply(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const reply = await readReply(request);
  if (reply === undefined) {
    badRequest(response, "expected JSON {comment: string, declarations?: [{id, note?, files?}]}");
    return;
  }
  // All-or-nothing: partial acceptance would make a safe retry duplicate the conversation.
  const problems = validateDeclarations(session, reply.declarations, (from, to) =>
    listDiffNames(session.repoRoot, from, to),
  );
  if (problems.length > 0) {
    sendJson(response, 422, declarationRejection(problems));
    return;
  }
  const now = new Date().toISOString();
  const updated = withDeclarations(
    withAgentReply(session, reply.comment, now),
    reply.declarations,
    now,
  );
  context.store.save(updated);
  logAgentReply(context.log, session, reply.comment, now);
  logDeclarations(context.log, session, reply.declarations, now);
  // The answer is the end of the work the last poll went off with.
  context.transport.setWorking(session.key, false);
  context.transport.publish(session.key, "session", { reason: "agent_reply" });
  sendJson(response, 200, { delivered: true, declared: reply.declarations.length });
}
