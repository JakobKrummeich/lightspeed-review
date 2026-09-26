import type { IncomingMessage, ServerResponse } from "node:http";
import type { ReviewErrorCode } from "../errors.ts";
import type { ReviewCloser } from "../session-types.ts";
import { readJsonBody } from "../router.ts";

/**
 * The 422 an illegal move is answered with: the rule the server refused, and the
 * move that makes it legal. Declared once and returned by every builder of one,
 * because the reading side is typed too (`api-client.ts`) — a code outside the
 * closed set reaches the agent as `internal_error`, which reads as a lightspeed
 * bug rather than something it can fix, and `help` is what it does next, so
 * there is always at least one line.
 *
 * Not the shape of the 409s a session's status answers: those carry no help,
 * because the client knows the one move an ended review leaves — only who
 * ended it, which the client cannot know (`SessionEndedBody`).
 */
export interface DomainErrorBody {
  error: { code: ReviewErrorCode; message: string; detail?: string };
  help: [string, ...string[]];
}

/** The 409 an agent's move on an ended review is answered with (`reviewEnded`). */
export interface SessionEndedBody {
  error: { code: "session_ended"; message: string };
  endedBy?: ReviewCloser;
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

export function badRequest(response: ServerResponse, message: string): void {
  sendJson(response, 400, { error: { code: "invalid_request", message } });
}

export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Request bodies are untrusted input: a body that is not JSON is simply absent. */
export async function readJsonSafely<T>(request: IncomingMessage): Promise<T | undefined> {
  try {
    return await readJsonBody<T>(request);
  } catch {
    return undefined;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
