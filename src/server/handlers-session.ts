/**
 * `announceRoundEnd` is shared with the feedback handler, whose "Send & End"
 * closes a round the same way.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { closedBy, withAgentReplies } from "../feedback.ts";
import { sessionKey } from "../paths.ts";
import {
  nextSessionRecord,
  withClosedRound,
  type CreateSessionRequest,
} from "../rounds/session-round.ts";
import type { SessionRecord } from "../session-types.ts";
import { reviewerTurn, turnFacts } from "../turn.ts";
import { handbackOf, isRerun, withHandback } from "../turn-moves.ts";
import { loadAssets } from "../static-assets.ts";
import { logReplies, unknownNotes } from "./agent-notes.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { badRequest, sendJson, type DomainErrorBody } from "./http.ts";
import { logOutcomes, logRound, logRoundEnd, type LedgerReport } from "./ledger-log.ts";
import { nothingToPublish, reviewerHolds, stillDigesting } from "./turn-refusals.ts";
import { parseCreateSession } from "./validate.ts";

/**
 * `open` and `publish` both arrive here, because both may open a round: `open`
 * on no session (or an ended one the reviewer asked to reopen), `publish` on
 * the agent's new commits. `open` on a live session opens nothing — it is an
 * agent re-attaching, and the CLI goes straight on to wait.
 */
export async function handleCreateSession(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const payload = await parseCreateSession(request);
  if (!payload) {
    badRequest(response, "expected JSON {repoRoot, branch, base, groups[]}");
    return;
  }
  const key = sessionKey(payload.repoRoot, payload.branch, payload.base);
  const existing = context.store.get(key);
  if (payload.verb === "publish") publish(context, response, existing, payload);
  else open(context, response, existing, payload);
}

function open(
  context: ServerContext,
  response: ServerResponse,
  existing: SessionRecord | undefined,
  payload: CreateSessionRequest,
): void {
  // A review the reviewer ended is theirs to restart. Refusing before anything
  // is written keeps the round they closed the round they see.
  if (existing?.status === "ended" && payload.reopen !== true) {
    sendJson(response, 409, endedError());
    return;
  }
  if (existing !== undefined && existing.status !== "ended") {
    sendJson(response, 200, { ...answerFor(context, existing), reattached: true });
    return;
  }
  const record = openNextRound(context, existing, payload, new Date().toISOString());
  sendJson(response, 200, { ...answerFor(context, record.session), ledger: record.ledger });
}

function publish(
  context: ServerContext,
  response: ServerResponse,
  existing: SessionRecord | undefined,
  payload: CreateSessionRequest,
): void {
  if (existing === undefined) sendJson(response, 404, missing());
  else if (existing.status === "ended") sendJson(response, 409, endedError());
  else publishLive(context, response, existing, payload);
}

function publishLive(
  context: ServerContext,
  response: ServerResponse,
  existing: SessionRecord,
  payload: CreateSessionRequest,
): void {
  const notes = payload.notes ?? [];
  const handback = handbackOf(existing, "publish", { intents: payload.intents, notes });
  const sameHead = headUnmoved(existing, payload);
  if (sameHead && isRerun(existing, handback)) {
    sendJson(response, 200, { ...answerFor(context, existing), rerun: true });
    return;
  }
  const refusal = publishRefusal(existing, sameHead) ?? unknownNotes(existing, notes);
  if (refusal !== undefined) {
    sendJson(response, 422, refusal);
    return;
  }
  publishRound(context, response, existing, payload, handback);
}

/** Only a HEAD both sides named can be said not to have moved. */
function headUnmoved(existing: SessionRecord, payload: CreateSessionRequest): boolean {
  return (
    payload.headCommit !== undefined && payload.headCommit === existing.rounds.at(-1)?.headCommit
  );
}

function publishRound(
  context: ServerContext,
  response: ServerResponse,
  existing: SessionRecord,
  payload: CreateSessionRequest,
  handback: ReturnType<typeof handbackOf>,
): void {
  const notes = payload.notes ?? [];
  const now = new Date().toISOString();
  const opened = openNextRound(context, existing, payload, now, (record) =>
    withHandback(withAgentReplies(record, notes, now), handback, now),
  );
  logReplies(context.log, opened.session, notes, now);
  sendJson(response, 200, { ...answerFor(context, opened.session), ledger: opened.ledger });
}

/** Publish ends a working turn with new commits, and nothing else. */
function publishRefusal(session: SessionRecord, sameHead: boolean): DomainErrorBody | undefined {
  const turn = session.turn;
  if (turn.holder === "reviewer") return reviewerHolds(session, "publish");
  if (turn.mode === "digesting") return stillDigesting(session);
  return sameHead ? nothingToPublish(session) : undefined;
}

/**
 * The notes of a `publish` land after the round opens, so they are stamped
 * with it: "done: …" is read beside the diff that did it.
 */
function openNextRound(
  context: ServerContext,
  existing: SessionRecord | undefined,
  payload: CreateSessionRequest,
  now: string,
  finish: (record: SessionRecord) => SessionRecord = (record) => record,
): { session: SessionRecord; ledger: LedgerReport } {
  refreshAssets(context);
  const round = context.nextId("rnd", now);
  const key = sessionKey(payload.repoRoot, payload.branch, payload.base);
  const record = finish(nextSessionRecord(existing, payload, { key, round, now }));
  context.store.save(record);
  const ledger = logRound(context.log, record, round, now);
  logOutcomes(context.log, record, round, now);
  context.transport.publishPresence(key);
  context.transport.publish(key, "session", { reason: "updated" });
  return { session: record, ledger };
}

function answerFor(context: ServerContext, session: SessionRecord) {
  return {
    key: session.key,
    url: `${context.baseUrl()}/session/${session.key}`,
    status: session.status,
    ...turnFacts(session),
  };
}

function endedError() {
  return {
    error: {
      code: "session_ended",
      message: "the reviewer ended this review; only they ask for a new round",
    },
  };
}

function missing() {
  return {
    error: { code: "session_not_found", message: "no review is open here; open one first" },
  };
}

/**
 * Re-snapshots the bundle on round open: the agent typically rebuilt before
 * reopening, and an old bundle would read the new round with old code. A build
 * broken mid-write must never cost the round — on any failure the old snapshot
 * (still a coherent page) stays.
 */
function refreshAssets(context: ServerContext): void {
  try {
    context.assets = loadAssets(context.staticDir);
  } catch {
    // Kept: serving the last good build beats crashing the round.
  }
}

export function handleEnd(
  context: ServerContext,
  _request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const now = new Date().toISOString();
  const ended = withClosedRound({
    ...session,
    status: "ended",
    ...closedBy(session, "agent"),
    turn: reviewerTurn(now),
    updatedAt: now,
  });
  context.store.save(ended);
  context.transport.wakePollers(session.key);
  announceRoundEnd(context, session, now);
  sendJson(response, 200, { status: "ended", ...turnFacts(ended) });
}

export function announceRoundEnd(
  context: ServerContext,
  session: SessionRecord,
  now: string,
): void {
  logRoundEnd(context.log, session, now);
  // Nothing is outstanding on a review that is over, whichever side closed it:
  // both routes write the reviewer's turn before they get here.
  context.transport.publishPresence(session.key);
  context.transport.publish(session.key, "session", { reason: "ended" });
}
