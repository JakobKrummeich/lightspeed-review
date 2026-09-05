/**
 * Request-body parsing for every POST the server takes. All input is untrusted:
 * anything malformed becomes `undefined` (a 400 upstream), never an exception.
 */
import type { IncomingMessage } from "node:http";
import {
  parseDeclarations,
  type CommentDeclaration,
  type DeclarationProblem,
} from "../declarations.ts";
import { parseFeedbackRequest } from "../feedback.ts";
import type { CreateSessionRequest } from "../rounds/session-round.ts";
import { readJsonSafely } from "./http.ts";

/** Anything unexpected in a create-session body becomes a 400. */
export async function parseCreateSession(
  request: IncomingMessage,
): Promise<CreateSessionRequest | undefined> {
  const payload = await readJsonSafely<Partial<CreateSessionRequest>>(request);
  if (payload === undefined) return undefined;
  const { repoRoot, branch, base, baseCommit, headCommit, groups, grouping, intents, commits } =
    payload;
  if (typeof repoRoot !== "string" || typeof branch !== "string" || typeof base !== "string") {
    return undefined;
  }
  if (!Array.isArray(groups)) return undefined;
  return {
    repoRoot,
    branch,
    base,
    ...commitsOf(baseCommit, headCommit),
    groups,
    ...(isGroupingMode(grouping) ? { grouping } : {}),
    // The CLI refuses to post a round with no intent; a body that carries none
    // is an older client, and a round with nothing to say is better than a 400.
    intents: stringList(intents),
    commits: stringList(commits),
    reopen: payload.reopen === true,
  };
}

/**
 * Untrusted: anything but the three modes is dropped, which reads as `llm` —
 * same as every round from before this was recorded.
 */
function isGroupingMode(value: unknown): value is "skipped" | "llm" | "fallback" {
  return value === "skipped" || value === "llm" || value === "fallback";
}

/** Untrusted input: anything that is not a list of strings is an empty list. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/** Commits are optional: a caller that could not resolve them sends neither. */
function commitsOf(
  baseCommit: unknown,
  headCommit: unknown,
): { baseCommit?: string; headCommit?: string } {
  return {
    ...(typeof baseCommit === "string" ? { baseCommit } : {}),
    ...(typeof headCommit === "string" ? { headCommit } : {}),
  };
}

export async function readFeedback(request: IncomingMessage) {
  return parseFeedbackRequest(await readJsonSafely<unknown>(request));
}

/** An agent reply: the round summary, plus whatever it declares per comment. */
export async function readReply(
  request: IncomingMessage,
): Promise<{ comment: string; declarations: CommentDeclaration[] } | undefined> {
  const payload = await readJsonSafely<{ comment?: unknown; declarations?: unknown }>(request);
  const comment = payload?.comment;
  if (typeof comment !== "string" || comment.trim() === "") return undefined;
  const declarations =
    payload?.declarations === undefined ? [] : parseDeclarations(payload.declarations);
  if (declarations === undefined) return undefined;
  return { comment, declarations };
}

/**
 * The 422 a rejected declaration answers with: every problem named, because
 * the agent fixes them all in one retry, and the retry is safe — nothing of a
 * rejected reply is stored.
 */
export function declarationRejection(problems: DeclarationProblem[]): unknown {
  return {
    error: {
      code: "declaration_invalid",
      message: `the reply was rejected whole: ${problems.length} declaration problem(s)`,
      detail: problems.map((problem) => `${problem.id}: ${problem.reason}`).join("; "),
    },
    help: [
      "Ids come from the annotations in `lightspeed poll` output",
      "Fix the declaration and re-send the whole reply; no part of it was delivered",
    ],
  };
}

export async function parseApproved(request: IncomingMessage): Promise<string[] | undefined> {
  const approved = (await readJsonSafely<{ approved?: unknown }>(request))?.approved;
  if (!Array.isArray(approved) || approved.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return approved as string[];
}
