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
import type { ReviewCloser } from "./session-types.ts";

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
