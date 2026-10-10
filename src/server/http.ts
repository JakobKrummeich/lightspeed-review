import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody } from "../router.ts";

export type { DomainErrorBody, SessionEndedBody } from "../api-contract.ts";

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
