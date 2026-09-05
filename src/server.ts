/**
 * The review server's composition root: options, context, the route table,
 * and the listen/stop lifecycle. The handlers live in `src/server/`,
 * as top-level functions over the `ServerContext` built here.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createIdSource } from "./ledger/records.ts";
import type { LedgerStore } from "./ledger/store.ts";
import type { CreateSessionRequest } from "./rounds/session-round.ts";
import { matchRoute, type Route, type RouteHandler } from "./router.ts";
import { type ContextHandler, type ServerContext } from "./server/context.ts";
import { handleAgentReply, handleApproved, handleFeedback } from "./server/handlers-feedback.ts";
import {
  handleApprovedForm,
  handleLastRoundForm,
  handleReplay,
  handleReviewPage,
  handleSessionData,
  handleSessionFile,
  handleStatic,
} from "./server/handlers-review.ts";
import { handleCreateSession, handleEnd } from "./server/handlers-session.ts";
import { handleEvents, handlePoll } from "./server/handlers-stream.ts";
import { messageOf, sendJson } from "./server/http.ts";
import type { LedgerReport } from "./server/ledger-log.ts";
import { hostIsAllowed, originIsAllowed } from "./server/security.ts";
import { SessionTransport } from "./server/streams.ts";
import type { SessionStore } from "./session-store.ts";
import { DEFAULT_STATIC_DIR, loadAssets } from "./static-assets.ts";

export type { CreateSessionRequest };
export type { LedgerReport };

export interface ReviewServerOptions {
  store: SessionStore;
  port: number;
  /** Absent when `feedbackLog` is `off`: there is then nothing to write through. */
  ledger?: LedgerStore;
  /** Loopback only. Overridable for tests, never for production use. */
  host?: string;
  /** Where the built browser bundle lives. Defaults to `dist/browser/`. */
  staticDir?: string;
}

export interface StartedServer {
  url: string;
  port: number;
}

export interface ReviewServer {
  start(): Promise<StartedServer>;
  stop(): Promise<void>;
  /** Resolves when the server stops, whether by request or by signal. */
  whenStopped(): Promise<void>;
  /** Pushes an SSE event to every browser watching one session. */
  publish(key: string, event: string, data: unknown): void;
}

export function createReviewServer(options: ReviewServerOptions): ReviewServer {
  const host = options.host ?? "127.0.0.1";
  const staticDir = options.staticDir ?? DEFAULT_STATIC_DIR;
  // Read whole so every request serves one build; a build under a running server
  // dates the page, never splits it. Re-read only on round open — see `refreshAssets`.
  const assets = loadAssets(staticDir);
  const transport = new SessionTransport();
  /** One id source per server: it orders every record this run writes. */
  const nextId = createIdSource();
  let server: Server | undefined;
  let announceStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (announceStopped = resolve));

  function currentPort(): number {
    const address = server?.address() as AddressInfo | null;
    return address?.port ?? options.port;
  }

  const baseUrl = () => `http://${host}:${currentPort()}`;

  async function stop(): Promise<void> {
    transport.closeAll();
    const running = server;
    server = undefined;
    if (!running) return;
    // Keep-alive sockets would otherwise hold `close` open indefinitely.
    running.closeAllConnections();
    await new Promise<void>((resolve) => running.close(() => resolve()));
    announceStopped();
  }

  const context: ServerContext = {
    store: options.store,
    log: { ledger: options.ledger, nextId },
    nextId,
    assets,
    staticDir,
    transport,
    currentPort,
    baseUrl,
    requestUrl: (request) => new URL(request.url ?? "/", baseUrl()),
    stop,
  };
  const routes = buildRoutes(context);

  return {
    async start(): Promise<StartedServer> {
      const created = createServer(
        (request, response) => void handleRequest(context, routes, request, response),
      );
      // Node's 5s keep-alive vs the client's 4s idle timeout is a race; if the
      // server wins, the next command reuses a dying socket. Outlast the client.
      created.keepAliveTimeout = 60_000;
      server = created;
      await listenOn(created, options.port, host);
      return { url: baseUrl(), port: currentPort() };
    },
    stop,
    whenStopped: () => stopped,
    publish: (key, event, data) => transport.publish(key, event, data),
  };
}

/** Every path the server answers, each bound to its handler over the shared context. */
function buildRoutes(context: ServerContext): Route[] {
  const bind =
    (handler: ContextHandler): RouteHandler =>
    (request, response, params) =>
      handler(context, request, response, params);
  return [
    {
      method: "GET",
      pattern: "/health",
      handler: (_request, response) => sendJson(response, 200, { status: "ok" }),
    },
    { method: "POST", pattern: "/api/sessions", handler: bind(handleCreateSession) },
    { method: "GET", pattern: "/session/:key", handler: bind(handleReviewPage) },
    { method: "GET", pattern: "/api/session/:key/data", handler: bind(handleSessionData) },
    { method: "GET", pattern: "/api/session/:key/file", handler: bind(handleSessionFile) },
    {
      method: "GET",
      pattern: "/api/session/:key/approved-form",
      handler: bind(handleApprovedForm),
    },
    {
      method: "GET",
      pattern: "/api/session/:key/last-round-form",
      handler: bind(handleLastRoundForm),
    },
    { method: "GET", pattern: "/api/session/:key/replay", handler: bind(handleReplay) },
    { method: "GET", pattern: "/api/session/:key/events", handler: bind(handleEvents) },
    { method: "POST", pattern: "/api/session/:key/approved", handler: bind(handleApproved) },
    { method: "POST", pattern: "/api/session/:key/feedback", handler: bind(handleFeedback) },
    { method: "POST", pattern: "/api/session/:key/reply", handler: bind(handleAgentReply) },
    { method: "POST", pattern: "/api/session/:key/end", handler: bind(handleEnd) },
    { method: "GET", pattern: "/api/poll", handler: bind(handlePoll) },
    { method: "POST", pattern: "/api/shutdown", handler: bind(handleShutdown) },
    { method: "GET", pattern: "/static/:asset", handler: bind(handleStatic) },
  ];
}

/** `lightspeed stop`: acknowledged before the socket goes away. */
function handleShutdown(
  context: ServerContext,
  _request: IncomingMessage,
  response: ServerResponse,
): void {
  response.on("finish", () => void context.stop());
  sendJson(response, 200, { status: "stopping" });
}

/** The security gate, the route dispatch, and the 500 that keeps failures JSON. */
async function handleRequest(
  context: ServerContext,
  routes: Route[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!hostIsAllowed(request) || !originIsAllowed(request, context.currentPort())) {
    sendJson(response, 403, {
      error: { code: "forbidden_host", message: "unexpected Host or Origin header" },
    });
    return;
  }
  const pathname = context.requestUrl(request).pathname;
  const match = matchRoute(routes, request.method ?? "GET", pathname);
  if (!match) {
    sendJson(response, 404, {
      error: { code: "not_found", message: `no route for ${pathname}` },
    });
    return;
  }
  try {
    await match.handler(request, response, match.params);
  } catch (error) {
    sendJson(response, 500, {
      error: { code: "internal_error", message: messageOf(error) },
    });
  }
}

/**
 * A listen failure (a busy port, usually) is an event, not a rejected promise,
 * and the caller has to be able to report it.
 */
async function listenOn(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
