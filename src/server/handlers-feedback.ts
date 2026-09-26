/**
 * Everything here writes the store first and the ledger second, so a broken
 * ledger never changes an answer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { withAgentReplies, withFeedback, type FeedbackRequest } from "../feedback.ts";
import { reviewPaths } from "../review-files.ts";
import { withClosedRound } from "../rounds/session-round.ts";
import type { AgentTurn, FeedbackPrompt, SessionRecord } from "../session-types.ts";
import { nextThreadId } from "../threads.ts";
import { turnFacts } from "../turn.ts";
import { handbackOf, isRerun, withHandback } from "../turn-moves.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { announceRoundEnd } from "./handlers-session.ts";
import { badRequest, sendJson, type DomainErrorBody } from "./http.ts";
import { everyPrompt, knownThreads, logReplies, unknownNotes } from "./agent-notes.ts";
import { logFeedback } from "./ledger-log.ts";
import { reviewEnded, reviewerHolds, stillWorking, unknownThreads } from "./turn-refusals.ts";
import { parseApproved, readFeedback, readReply, type ReplyRequest } from "./validate.ts";

export async function handleApproved(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const posted = await parseApproved(request);
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
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
  const feedback = await readFeedback(request);
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  if (!feedback) {
    badRequest(response, "expected JSON {prompts: [{type, comment, ...}], ended: bool}");
    return;
  }
  const locked = lockedOut(session, feedback);
  if (locked !== undefined) {
    sendJson(response, 409, locked);
    return;
  }
  // Ids minted here, where the whole conversation is known: they must be
  // short and unique for the session's life, and exist with the ledger off.
  const prompts = withThreadIds(session, feedback.prompts);
  const unknown = unknownTargets(session, prompts);
  if (unknown.length > 0) {
    sendJson(response, 422, unknownThreads(session, unknown, knownThreads(session)));
    return;
  }
  const now = new Date().toISOString();
  const updated = withFeedback(session, { ...feedback, prompts }, now);
  context.store.save(feedback.ended ? withClosedRound(updated) : updated);
  logFeedback(context.log, session, prompts, now);
  context.transport.wakePollers(session.key);
  context.transport.publish(session.key, "feedback", { queued: prompts.length });
  // "Send & End" is the reviewer closing the round, so it closes like one.
  if (feedback.ended) announceRoundEnd(context, session, now);
  sendJson(response, 200, { queued: prompts.length });
}

/**
 * The page's lock, enforced where it cannot be raced: a tab that missed the
 * presence frame, or a second tab, must not change the batch under an agent
 * reading it, nor slip words into a round the agent is building. Ending with
 * nothing is never refused — the reviewer can always walk away — but an ending
 * Send's words are: no command ever hands them to an agent that holds the turn,
 * whose next call only hears that the review ended.
 */
function lockedOut(session: SessionRecord, feedback: FeedbackRequest): DomainErrorBody | undefined {
  if (session.status === "ended" || session.turn.holder !== "agent") return undefined;
  if (feedback.ended) return feedback.prompts.length === 0 ? undefined : wordsOnEnd();
  const message =
    session.turn.mode === "working"
      ? "the agent is working on your feedback; queue this for the next round"
      : "the agent is reading your last batch; wait for its answer";
  return {
    error: {
      code: "agent_holds_turn",
      message,
      detail: "nothing was sent; your words are still on the page",
    },
    help: ["End the review at any time; everything else waits for the agent to hand back"],
  };
}

function wordsOnEnd(): DomainErrorBody {
  return {
    error: {
      code: "agent_holds_turn",
      message:
        "the agent holds the turn, so words sent with the end would never be read — End without Sending ends the review now",
      detail: "nothing was sent and the review is still open; your words are still on the page",
    },
    help: [
      "End without Sending ends the review now; to have them read, wait for the agent to hand back",
    ],
  };
}

/** Every new item opens a thread: `t1`, `t2`… in the order they were sent. */
function withThreadIds(session: SessionRecord, prompts: FeedbackPrompt[]): FeedbackPrompt[] {
  let known = everyPrompt(session);
  return prompts.map((prompt) => {
    if (prompt.type !== "annotation" && prompt.type !== "message") return prompt;
    const named = { ...prompt, id: nextThreadId(known) };
    known = [...known, named];
    return named;
  });
}

/** Replies and resolves may name only threads that exist, this Send's new ones included. */
function unknownTargets(session: SessionRecord, prompts: FeedbackPrompt[]): string[] {
  const known = knownThreads(session, prompts);
  return prompts
    .filter((prompt) => prompt.type === "reply" || prompt.type === "resolve")
    .map((prompt) => prompt.thread)
    .filter((thread) => !known.has(thread));
}

/**
 * `lightspeed reply`: every answer of the turn, each under its item, and the
 * turn back to the reviewer. Recognised before anything else as a re-run of
 * the last reply, which is answered as if it had just been posted — the CLI
 * then waits again, re-attaching to whatever the reviewer sent meanwhile.
 */
export async function handleAgentReply(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const reply = await readReply(request);
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  if (reply === undefined) {
    badRequest(
      response,
      "expected JSON {replies: [{to, text}, ...], head?, tree?} with at least one reply",
    );
    return;
  }
  // Words spoken into a review that is over reach nobody, and only the reviewer
  // asks for another round: refused rather than filed where nobody looks.
  if (session.status === "ended") {
    sendJson(response, 409, reviewEnded(session));
    return;
  }
  const handback = handbackOf(session, "reply", reply.replies);
  if (isRerun(session, handback)) {
    sendJson(response, 200, { ...turnFacts(session), rerun: true });
    return;
  }
  const refusal = replyRefusal(session, reply);
  if (refusal !== undefined) {
    sendJson(response, 422, refusal);
    return;
  }
  const now = new Date().toISOString();
  const updated = withHandback(withAgentReplies(session, reply.replies, now), handback, now);
  context.store.save(updated);
  logReplies(context.log, session, reply.replies, now);
  context.transport.publishPresence(session.key);
  context.transport.publish(session.key, "session", { reason: "agent_reply" });
  sendJson(response, 200, { ...turnFacts(updated), replied: reply.replies.length });
}

/**
 * Legal while digesting; from working only while there is nothing to lose by
 * talking (W2): HEAD and the tree where `work` found them.
 */
function replyRefusal(session: SessionRecord, reply: ReplyRequest): DomainErrorBody | undefined {
  const turn = session.turn;
  if (turn.holder === "reviewer") return reviewerHolds(session, "reply");
  const changed = turn.mode === "working" ? changedSinceWork(turn, reply) : undefined;
  if (changed !== undefined) {
    return stillWorking(
      session,
      `reply from working is only for when nothing has changed since \`work\`: ${changed},` +
        " and the reviewer would be answering beside half-written code",
    );
  }
  return unknownNotes(session, reply.replies);
}

/** Which condition failed, named: "HEAD moved or the tree is dirty" sent agents hunting. */
function changedSinceWork(turn: AgentTurn, reply: ReplyRequest): string | undefined {
  if (turn.head === undefined) return "no HEAD was recorded at work, so nothing vouches for it";
  if (reply.head !== turn.head) return "HEAD moved since work";
  if (turn.tree === undefined) return "no tree was recorded at work, so nothing vouches for it";
  return reply.tree === turn.tree ? undefined : "the working tree changed since work";
}
