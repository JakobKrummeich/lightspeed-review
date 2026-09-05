/**
 * The read side of a review: the page shell, the session payload, whole file
 * contents, approved-form diffs, the between-rounds replay, and static assets.
 * Nothing here writes to the store or the ledger.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readDiffBetween, readFileAtCommit } from "../git-file.ts";
import { renderReviewPage } from "../html-template.ts";
import { approvedForm } from "../rounds/approved-form.ts";
import { lastRoundForm } from "../rounds/last-round-form.ts";
import { roundApproval } from "../rounds/history.ts";
import { replayData } from "../rounds/replay.ts";
import { currentCommits, currentIntents } from "../rounds/session-round.ts";
import { requireSession, type ServerContext } from "./context.ts";
import { sendJson } from "./http.ts";
import { approvedFormData, gitPathOf, readSessionFile } from "./session-files.ts";

export function handleReviewPage(
  context: ServerContext,
  _request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(renderReviewPage(session));
}

export function handleSessionData(
  context: ServerContext,
  _request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  // Approval is derived on every read, never stored: the rounds are the truth,
  // and a stored copy could disagree with them after an `end` or a re-group.
  sendJson(response, 200, {
    ...session,
    approval: roundApproval(session.rounds, session.approved),
    intents: currentIntents(session),
    commits: currentCommits(session),
  });
}

/**
 * The whole file behind a diff: the browser highlights the full text and paints
 * diff rows from it — a hunk alone is not valid code (JSX, block comments,
 * template literals span its edges).
 */
export function handleSessionFile(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const query = context.requestUrl(request).searchParams;
  const path = query.get("path") ?? "";
  const side = query.get("side") === "old" ? "old" : "new";
  const contents = readSessionFile(session, path, side);
  if (contents === undefined) {
    sendJson(response, 404, {
      error: { code: "file_unavailable", message: `no ${side} version of ${path}` },
    });
    return;
  }
  sendJson(response, 200, { path, side, contents });
}

/**
 * What the agent did to a file since the reviewer approved it: diff from the
 * ticked round's head to the current round's, plus the intervening intents.
 * On demand, not shipped with the session — a git subprocess per file, and most
 * files are never toggled. Only `needs-reapproval` files have one (live ticks
 * deliberately not consulted, so a just-re-ticked page still gets an answer),
 * and only paths this round's grouping lists — the file endpoint's same gate.
 */
export function handleApprovedForm(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const path = context.requestUrl(request).searchParams.get("path") ?? "";
  const listed = gitPathOf(session, path, "new") !== undefined;
  const form = listed ? approvedForm(session.rounds, path) : undefined;
  if (form === undefined) {
    sendJson(response, 404, {
      error: {
        code: "no_approved_form",
        message: `${path} has no approval for this round to be read against`,
      },
    });
    return;
  }
  sendJson(response, 200, approvedFormData(session, path, form));
}

/**
 * Same question for a never-approved file: the change between the two newest
 * rounds, proven by recorded blob shas. On demand for the same cost reason.
 * Only a file both rounds list with differing blobs has one; `needs-reapproval`
 * files are refused — they carry the approved-form switch instead, one
 * comparison per file, never two.
 */
export function handleLastRoundForm(
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  const path = context.requestUrl(request).searchParams.get("path") ?? "";
  const listed = gitPathOf(session, path, "new") !== undefined;
  const form = listed ? lastRoundForm(session.rounds, path) : undefined;
  if (form === undefined) {
    sendJson(response, 404, {
      error: {
        code: "no_last_round_form",
        message: `${path} did not change between the last two rounds`,
      },
    });
    return;
  }
  sendJson(response, 200, approvedFormData(session, path, form));
}

/**
 * Between-rounds replay: last round's comments with the agent's declared answer
 * or the mechanical fallback. Recomputed from session + git on every read — the
 * ledger is never consulted, so replay works with it off. First round or no
 * comments answers an empty list: "nothing to replay" is a definitive answer.
 */
export function handleReplay(
  context: ServerContext,
  _request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const session = requireSession(context.store, response, params.key);
  if (!session) return;
  sendJson(
    response,
    200,
    replayData(
      session,
      (from, to, paths) => readDiffBetween(session.repoRoot, from, to, paths),
      (commit, path) => readFileAtCommit(session.repoRoot, commit, path),
    ),
  );
}

/**
 * Serves the start-time snapshot. The name is a map key, never joined onto a
 * directory: traversal is impossible by construction, not by pattern.
 */
export function handleStatic(
  context: ServerContext,
  _request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) {
  const asset = params.asset ?? "";
  const found = context.assets.get(asset);
  if (!found) {
    sendJson(response, 404, {
      error: {
        code: "asset_missing",
        message: `no browser asset ${asset} in ${context.staticDir} — run \`pnpm run build\``,
      },
    });
    return;
  }
  response.writeHead(200, { "content-type": found.contentType });
  response.end(found.contents);
}
