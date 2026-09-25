/**
 * All input is untrusted: anything malformed becomes `undefined` (a 400
 * upstream), never an exception.
 */
import type { IncomingMessage } from "node:http";
import { parseFeedbackRequest, type AgentNote } from "../feedback.ts";
import type { CreateSessionRequest } from "../rounds/session-round.ts";
import { readJsonSafely } from "./http.ts";

export async function parseCreateSession(
  request: IncomingMessage,
): Promise<CreateSessionRequest | undefined> {
  const payload = await readJsonSafely<Partial<CreateSessionRequest>>(request);
  if (payload === undefined || !hasSessionShape(payload)) return undefined;
  const { repoRoot, branch, base, baseCommit, headCommit, groups, grouping, intents, commits } =
    payload;
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
    verb: payload.verb === "publish" ? "publish" : "open",
    notes: parseNotes(payload.notes) ?? [],
  };
}

function hasSessionShape(
  payload: Partial<CreateSessionRequest>,
): payload is Partial<CreateSessionRequest> &
  Pick<CreateSessionRequest, "repoRoot" | "branch" | "base" | "groups"> {
  const { repoRoot, branch, base, groups } = payload;
  const named = [repoRoot, branch, base].every((value) => typeof value === "string");
  return named && Array.isArray(groups);
}

function isGroupingMode(value: unknown): value is "skipped" | "llm" | "fallback" {
  return value === "skipped" || value === "llm" || value === "fallback";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

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
 * `reply`: every answer of the turn at once, each under the item it concerns.
 * `head`/`clean` are the CLI's account of the working tree, which only a reply
 * from `working` needs (W2: nothing half-written to protect).
 */
export interface ReplyRequest {
  replies: AgentNote[];
  head?: string;
  clean?: boolean;
}

export async function readReply(request: IncomingMessage): Promise<ReplyRequest | undefined> {
  const body = await readJsonSafely<{ replies?: unknown; head?: unknown; clean?: unknown }>(
    request,
  );
  if (body === undefined) return undefined;
  const replies = parseNotes(body.replies);
  // A reply with nothing to say is not a reply (D1).
  if (replies === undefined || replies.length === 0) return undefined;
  return {
    replies,
    ...(typeof body.head === "string" ? { head: body.head } : {}),
    ...(typeof body.clean === "boolean" ? { clean: body.clean } : {}),
  };
}

/** All or nothing: one malformed note fails the list, since a partial post cannot be re-run safely. */
function parseNotes(value: unknown): AgentNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes = value.map(parseNote);
  return notes.every((note) => note !== undefined) ? notes : undefined;
}

function parseNote(entry: unknown): AgentNote | undefined {
  const { to, text } = (entry ?? {}) as { to?: unknown; text?: unknown };
  const named = typeof to === "string" && to !== "";
  const said = typeof text === "string" && text.trim() !== "";
  return named && said ? { to, text } : undefined;
}

export async function readDelivered(request: IncomingMessage): Promise<string | undefined> {
  const delivery = (await readJsonSafely<{ delivery?: unknown }>(request))?.delivery;
  if (typeof delivery !== "string" || delivery === "") return undefined;
  return delivery;
}

export async function readWork(
  request: IncomingMessage,
): Promise<{ plan: string; head?: string } | undefined> {
  const body = await readJsonSafely<{ plan?: unknown; head?: unknown }>(request);
  const plan = body?.plan;
  if (typeof plan !== "string" || plan.trim() === "") return undefined;
  return { plan, ...(typeof body?.head === "string" ? { head: body.head } : {}) };
}

export async function parseApproved(request: IncomingMessage): Promise<string[] | undefined> {
  const approved = (await readJsonSafely<{ approved?: unknown }>(request))?.approved;
  if (!Array.isArray(approved) || approved.some((entry) => typeof entry !== "string")) {
    return undefined;
  }
  return approved as string[];
}
