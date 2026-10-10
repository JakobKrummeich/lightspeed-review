/**
 * The CLI ⇄ server protocol, declared once. Both `src/commands/` and
 * `src/server/` import this file and it imports neither, so a field renamed on
 * one side fails typecheck on the other instead of reaching an agent as
 * `undefined` (docs/architecture/reviews/2026-10-09-cli-server-wire-contract.md).
 *
 * Imports only types from modules below both sides; importing `server.ts`
 * would close an import cycle (`no-circular` in `pnpm arch`).
 */
import type { RefusalCode, ReviewErrorCode } from "./errors.ts";
import type { AgentNote } from "./feedback.ts";
import type { ReviewCloser } from "./session-types.ts";
import type { TurnFacts } from "./turn.ts";

/**
 * Every route the CLI calls, keyed exactly as `src/server.ts` registers it:
 * searching a route literal lands on this entry, the handler that answers it
 * (`cliHandlers`) and the command that calls it (`callApi`). `request` is the
 * JSON body (`undefined`: none is sent); `answer` is the 200's body.
 */
export interface CliRoutes {
  "POST /api/session/:key/work": { request: WorkRequest; answer: WorkAnswer };
  "POST /api/session/:key/reply": { request: ReplyRequest; answer: ReplyAnswer };
  "POST /api/session/:key/end": { request: undefined; answer: EndAnswer };
}
export type CliRoute = keyof CliRoutes;

/** What a route's path needs filled in: `:key` is the only capture any CLI route has. */
export type CliRouteParams<R extends CliRoute> = R extends `${string}:key${string}`
  ? { key: string }
  : Record<never, never>;

/**
 * The one place a contract key is split into what the router matches, so the
 * client that calls a route and the table that registers it cannot read one
 * key two ways.
 */
export function routeParts(route: CliRoute): { method: "GET" | "POST"; pattern: string } {
  const [method, pattern] = route.split(" ") as ["GET" | "POST", string];
  return { method, pattern };
}

/**
 * `work`: the plan the reviewer's header names, and the agent's account of the
 * tree it starts from, which a later `reply` from working is measured against.
 */
export interface WorkRequest {
  plan: string;
  head?: string;
  tree?: string;
}

/** `changed: false` is a redeclared plan; `open` is what `publish --to` may name. */
export type WorkAnswer = TurnFacts & { changed: boolean; open: string[] };

/**
 * `reply`: every answer of the turn at once, each under the item it concerns.
 * `head`/`tree` are the CLI's account of the working tree, which only a reply
 * from `working` needs (W2: nothing half-written to protect).
 */
export interface ReplyRequest {
  replies: AgentNote[];
  head?: string;
  tree?: string;
}

/** `rerun`: the last reply posted again, answered as if it had just landed and stored once. */
export type ReplyAnswer = TurnFacts & ({ replied: number } | { rerun: true });

/** `end` answers the same whether it closed the review or found it closed. */
export type EndAnswer = TurnFacts & { status: "ended" };

/**
 * The 422 an illegal move is answered with: the rule the server refused, and the
 * move that makes it legal. Declared once and returned by every builder of one,
 * because the reading side relays only `REFUSAL_CODES` (`api-client.ts`) — a
 * code outside that list reaches the agent as `internal_error`, which reads as
 * a lightspeed bug rather than something it can fix, and `help` is what it does
 * next, so there is always at least one line. `C` is widened only for a body
 * the page reads and the CLI never does (`lockedOut`).
 *
 * Not the shape of the 409s a session's status answers: those carry no help,
 * because the client knows the one move an ended review leaves — only who
 * ended it, which the client cannot know (`SessionEndedBody`).
 */
export interface DomainErrorBody<C extends ReviewErrorCode = RefusalCode> {
  error: { code: C; message: string; detail?: string };
  help: [string, ...string[]];
}

/** The 409 an agent's move on an ended review is answered with (`reviewEnded`). */
export interface SessionEndedBody {
  error: { code: "session_ended"; message: string };
  endedBy?: ReviewCloser;
}

/** Whether the feedback ledger took a round's records, as `publish` reports it. */
export interface LedgerReport {
  status: "on" | "off" | "degraded";
  path?: string;
  reason?: string;
}
