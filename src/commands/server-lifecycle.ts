import { spawn } from "node:child_process";
import { ReviewError } from "../errors.ts";
import { assertBundlePresent, DEFAULT_STATIC_DIR } from "../static-assets.ts";
import { probePort, reviewServerIsUp } from "./server-address.ts";

export interface EnsureServerOptions {
  port: number;
  /** Injected in tests; production spawns a detached `serve` process. */
  spawnServer?: () => void;
  /** How long the spawned server has to answer `/health`. */
  timeoutMs?: number;
  /** Where the built browser bundle lives. Defaults to `dist/browser/`. */
  staticDir?: string;
}

const READY_POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Makes sure a review server owns `port`, starting one in the background if not.
 * The server outlives the command — that is what lets `start` hand out a URL and exit. */
export async function ensureServerRunning(options: EnsureServerOptions): Promise<void> {
  // Who owns the port decides everything: our own server means nothing to do;
  // anything else means spawning would turn a clear conflict into a startup timeout.
  if ((await probePort(options.port)) === "open") {
    if (await reviewServerIsUp(options.port)) return;
    throw portUnavailable(options.port);
  }
  // The spawned server checks the bundle too, but detached with no stdio its error
  // is just a startup timeout. Asking here costs two stat calls and answers exactly.
  assertBundlePresent(options.staticDir ?? DEFAULT_STATIC_DIR);
  (options.spawnServer ?? spawnDetachedServer)();
  if (await answersWithin(options.port, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)) return;
  throw new ReviewError({
    code: "server_not_running",
    message: `the review server did not come up on port ${options.port}`,
    detail: "another process may hold the port, or the server crashed on startup",
    suggestions: [
      "Run `lightspeed serve` in the foreground to see why it fails",
      "Set a different `port` in .lightspeed.conf.json",
    ],
  });
}

/** Polls `/health` until the spawned server answers or the deadline passes. */
async function answersWithin(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    if (await reviewServerIsUp(port)) return true;
  }
  return false;
}

function portUnavailable(port: number): ReviewError {
  return new ReviewError({
    code: "port_unavailable",
    message: `port ${port} is held by something that is not a review server`,
    suggestions: [
      `Set a free \`port\` in .lightspeed.conf.json instead of ${port}`,
      "Stop whatever is listening there and re-run the command",
    ],
  });
}

/** Detached and fully disowned: the reviewer's browser must keep working after the
 * agent's shell (and any process-group signal it receives) is gone. */
function spawnDetachedServer(): void {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error("cannot find the lightspeed entry point");
  const child = spawn(process.execPath, [entry, "serve"], {
    detached: true,
    stdio: "ignore",
  });
  // Spawn failure reported by the health-check timeout, not an unhandled 'error' event.
  child.on("error", () => undefined);
  child.unref();
}
