import type { FeedbackLogMode } from "../config.ts";
import { ReviewError } from "../errors.ts";
import { ledgerFor } from "../ledger/store.ts";
import type { StructuredOutput } from "../output.ts";
import { createReviewServer } from "../server.ts";
import { SessionStore } from "../session-store.ts";
import { HELP_START } from "./home.ts";
import { reviewServerIsUp } from "./server-address.ts";

export interface ServeInput {
  stateDir: string;
  port: number;
  feedbackLog: FeedbackLogMode;
}

/** Anything but a busy port is a bug, reported as itself. A busy port is asked who
 * holds it first: `serve` once said "not a review server" of a port it never probed
 * — the one answer that sends an agent hunting a process that is not there. */
async function portInUse(error: unknown, port: number): Promise<unknown> {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") return error;
  if (await reviewServerIsUp(port)) {
    return new ReviewError({
      code: "server_already_running",
      message: `a review server is already running on port ${port}`,
      detail: "it answered /health on that port, so there is nothing to start",
      suggestions: [
        HELP_START,
        "Run `lightspeed stop` first if you meant to replace the running server",
      ],
    });
  }
  return new ReviewError({
    code: "port_unavailable",
    message: `port ${port} is already in use`,
    detail: "another process is listening there, and it did not answer /health",
    suggestions: [
      "Run `lightspeed stop` if an old review server is still running",
      `Set a free \`port\` in .lightspeed.conf.json instead of ${port}`,
    ],
  });
}

/** Runs the review server in the foreground until `lightspeed stop` or Ctrl+C.
 * `start` spawns this detached; a human can run it directly to see startup failures. */
export async function runServe(input: ServeInput): Promise<StructuredOutput> {
  const server = createReviewServer({
    store: new SessionStore(input.stateDir),
    ledger: ledgerFor(input.feedbackLog, input.stateDir),
    port: input.port,
  });
  const { port } = await server.start().catch(async (error: unknown) => {
    throw await portInUse(error, input.port);
  });
  const onSignal = () => void server.stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  await server.whenStopped();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return {
    server: { port, status: "stopped" },
    message: "the review server is no longer listening",
    help: [HELP_START],
  };
}
