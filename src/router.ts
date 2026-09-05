import type { IncomingMessage, ServerResponse } from "node:http";

export type RouteParams = Record<string, string>;

export type RouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  params: RouteParams,
) => void | Promise<void>;

export interface Route {
  method: "GET" | "POST";
  /** Literal segments plus `:name` captures, e.g. `/api/session/:key/data`. */
  pattern: string;
  handler: RouteHandler;
}

export interface RouteMatch {
  handler: RouteHandler;
  params: RouteParams;
}

export function matchRoute(
  routes: Route[],
  method: string,
  pathname: string,
): RouteMatch | undefined {
  const segments = splitPath(pathname);
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchSegments(splitPath(route.pattern), segments);
    if (params) return { handler: route.handler, params };
  }
  return undefined;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function matchSegments(pattern: string[], actual: string[]): RouteParams | undefined {
  if (pattern.length !== actual.length) return undefined;
  const params: RouteParams = {};
  for (const [index, expected] of pattern.entries()) {
    const segment = actual[index] ?? "";
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(segment);
      continue;
    }
    if (expected !== segment) return undefined;
  }
  return params;
}

/** Reads a JSON request body. Rejects oversized or malformed payloads. */
export async function readJsonBody<T>(
  request: IncomingMessage,
  limitBytes = 64 * 1024 * 1024,
): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}
