/**
 * The context every route handler takes instead of closing over server state:
 * handlers stay top-level functions whose dependencies are visible in their
 * signature, and the composition root in `server.ts` builds the one instance.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IdSource } from "../ledger/records.ts";
import type { SessionRecord, SessionStore } from "../session-store.ts";
import type { AssetSnapshot } from "../static-assets.ts";
import { sendJson } from "./http.ts";
import type { LedgerLog } from "./ledger-log.ts";
import type { SessionTransport } from "./streams.ts";

export interface ServerContext {
  store: SessionStore;
  /** The ledger hooks' shared context; its id source is `nextId`, below. */
  log: LedgerLog;
  /** Mints round and annotation ids; shared with `log` so one sequence orders the run. */
  nextId: IdSource;
  /** The browser bundle snapshot taken at server start. */
  assets: AssetSnapshot;
  staticDir: string;
  transport: SessionTransport;
  /** The bound port once listening; the configured port before that. */
  currentPort(): number;
  baseUrl(): string;
  /** A request's URL resolved against this server's own origin. */
  requestUrl(request: IncomingMessage): URL;
  stop(): Promise<void>;
}

/** Every route handler: the shared context first, then the plain HTTP triple. */
export type ContextHandler = (
  context: ServerContext,
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

export function requireSession(
  store: SessionStore,
  response: ServerResponse,
  key: string | undefined,
): SessionRecord | undefined {
  const session = key === undefined ? undefined : store.get(key);
  if (!session) {
    sendJson(response, 404, {
      error: { code: "session_not_found", message: `no session ${key}` },
    });
    return undefined;
  }
  return session;
}
