/**
 * The wire vocabulary every server module shares: JSON responses, SSE frames,
 * and body reading that treats malformed input as absent rather than an error.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../router.ts";

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/** The one 400 every malformed body gets: same shape, handler-specific message. */
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
