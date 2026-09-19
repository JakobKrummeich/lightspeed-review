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
import { readJsonSafely, type DomainErrorBody } from "./http.ts";

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

/**
 * The agent speaking: `say` sends a comment, a pinned answer, or both; `ask`
 * sends a comment marked as a question. A body saying neither is rejected — an
 * empty turn in the conversation reads as words lost, not words never said.
 */
export interface AgentReply {
  /** Absent when the whole answer was pinned under one comment (`say --for`). */
  comment?: string;
  /** `ask`: the panel draws an answer box under it and the turn goes back. */
  kind?: "question";
  declarations: CommentDeclaration[];
}

interface ReplyBody {
  comment?: unknown;
  kind?: unknown;
  declarations?: unknown;
}

export async function readReply(request: IncomingMessage): Promise<AgentReply | undefined> {
  const body = (await readJsonSafely<ReplyBody>(request)) ?? {};
  const comment = spokenWords(body.comment);
  const declarations = body.declarations === undefined ? [] : parseDeclarations(body.declarations);
  if (declarations === undefined) return undefined;
  if (rejected(body, comment, declarations)) return undefined;
  return {
    ...(comment === undefined ? {} : { comment }),
    ...(body.kind === "question" ? { kind: "question" as const } : {}),
    declarations,
  };
}

/** The three bodies that would land in the conversation as words nobody said. */
function rejected(
  body: ReplyBody,
  comment: string | undefined,
  declarations: CommentDeclaration[],
): boolean {
  // A comment field that says nothing is a mistake, not silence.
  if (body.comment !== undefined && comment === undefined) return true;
  // A question with nothing to ask is not a question; only spoken words carry it.
  if (body.kind === "question" && comment === undefined) return true;
  // Neither spoken nor pinned: nothing to deliver at all.
  return comment === undefined && declarations.length === 0;
}

/** Words the reviewer could read, or nothing. Blank is nothing. */
function spokenWords(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

/**
 * `delivered`: the id of the handover the agent is confirming. Untrusted like
 * every body here — an unreadable one is absent, and confirms nothing.
 */
export async function readDelivered(request: IncomingMessage): Promise<string | undefined> {
  const delivery = (await readJsonSafely<{ delivery?: unknown }>(request))?.delivery;
  if (typeof delivery !== "string" || delivery === "") return undefined;
  return delivery;
}

/** `work`: the plan the agent is about to go quiet over. */
export async function readWork(request: IncomingMessage): Promise<string | undefined> {
  const plan = (await readJsonSafely<{ plan?: unknown }>(request))?.plan;
  if (typeof plan !== "string" || plan.trim() === "") return undefined;
  return plan;
}

/**
 * The 422 a rejected declaration answers with: every problem named, because
 * the agent fixes them all in one retry, and the retry is safe — nothing of a
 * rejected reply is stored.
 */
export function declarationRejection(
  problems: DeclarationProblem[],
  target: string,
): DomainErrorBody {
  return {
    error: {
      code: "declaration_invalid",
      message: `the reply was rejected whole: ${problems.length} declaration problem(s)`,
      detail: problems.map((problem) => `${problem.id}: ${problem.reason}`).join("; "),
    },
    help: wayOut(problems, target),
  };
}

/**
 * The way out, and it has to be a command the CLI accepts: a rejection whose
 * escape hatch named `--note` cost the agent a second turn on `unknown flag
 * --note`. Only a rejection that is entirely about one comment's files can be
 * re-sent without them, so only that one keeps the `--for`; anything else is a
 * bad id or an empty entry, which only dropping the claim fixes.
 *
 * Neither branch restates the detail. Where an id comes from is already in the
 * problem's own reason, and a `help[]` that says it again is a line an agent
 * pays for twice and learns from once.
 */
function wayOut(problems: DeclarationProblem[], target: string): [string, ...string[]] {
  const ids = new Set(problems.map((problem) => problem.id));
  const [id] = ids;
  if (id === undefined || ids.size > 1 || problems.some((problem) => problem.kind !== "files")) {
    return [
      `Say it without the claim: \`lightspeed say "<text>" ${target}\``,
      "Or re-send the whole reply with a declaration that parses; nothing of this one was stored",
    ];
  }
  return [
    `Say it without the claim now: \`lightspeed say "<text>" ${target} --for ${id}\``,
    `Or commit, run \`lightspeed start ${target} --intent "<why>"\`,` +
      " then re-send the same line with --files",
  ];
}

export async function parseApproved(request: IncomingMessage): Promise<string[] | undefined> {
  const approved = (await readJsonSafely<{ approved?: unknown }>(request))?.approved;
  if (!Array.isArray(approved) || approved.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return approved as string[];
}
