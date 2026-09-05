/**
 * Session lifecycle: the agent opening a round by posting a session, and the
 * review being closed. `announceRoundEnd` is shared with the feedback handler,
 * whose "Send & End" closes a round the same way.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { closedBy } from "../feedback.ts";
import { sessionKey } from "../paths.ts";
import { nextSessionRecord, withClosedRound } from "../rounds/session-round.ts";
import type { SessionRecord } from "../session-store.ts";
import { loadAssets } from "../static-assets.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { badRequest, sendJson } from "./http.ts";
import { logOutcomes, logRound, logRoundEnd } from "./ledger-log.ts";
import { parseCreateSession } from "./validate.ts";

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
  // A review the reviewer ended is theirs to restart. Refusing before anything
  // is written keeps the round they closed the round they see.
  if (existing?.status === "ended" && payload.reopen !== true) {
    sendJson(response, 409, {
      error: {
        code: "session_ended",
        message: "the reviewer ended this review; only they ask for a new round",
      },
    });
    return;
  }
  refreshAssets(context);
  const now = new Date().toISOString();
  const round = context.nextId("rnd", now);
  const record = nextSessionRecord(existing, payload, { key, round, now });
  context.store.save(record);
  const ledger = logRound(context.log, record, round, now);
  logOutcomes(context.log, record, round, now);
  // A round opens on finished work: whatever the last poll took away has landed.
  context.transport.setWorking(key, false);
  context.transport.publish(key, "session", { reason: "updated" });
  sendJson(response, 200, {
    key,
    url: `${context.baseUrl()}/session/${key}`,
    status: record.status,
    ledger,
  });
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

/** Agent-initiated close: the reviewer's browser and any poller both learn. */
export function handleEnd(
  context: ServerContext,
  _request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const now = new Date().toISOString();
  context.store.save(
    withClosedRound({
      ...session,
      status: "ended",
      ...closedBy(session, "agent"),
      updatedAt: now,
    }),
  );
  context.transport.wakePollers(session.key);
  announceRoundEnd(context, session, now);
  sendJson(response, 200, { status: "ended" });
}

/** A closed round is logged once and the status changes under every open tab. */
export function announceRoundEnd(
  context: ServerContext,
  session: SessionRecord,
  now: string,
): void {
  logRoundEnd(context.log, session, now);
  // Nothing is outstanding on a review that is over, whichever side closed it.
  context.transport.setWorking(session.key, false);
  context.transport.publish(session.key, "session", { reason: "ended" });
}
