import { spawn } from "node:child_process";
import { ReviewError } from "../errors.ts";
import { assertBundlePresent, DEFAULT_STATIC_DIR } from "../static-assets.ts";
import { CLI_VERSION } from "../version.ts";
import { probePort, requestShutdown, reviewServerIsUp, serverHealth } from "./server-address.ts";

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

/** How long a server of another version gets to release the port. */
const STALE_SHUTDOWN_MS = 2_000;

/** Makes sure a review server owns `port`, starting one in the background if not.
 * The server outlives the command — that is what lets `start` hand out a URL and exit. */
export async function ensureServerRunning(options: EnsureServerOptions): Promise<void> {
  // Who owns the port decides everything: our own server of this version means
  // nothing to do, one of another version has to go, and anything else means
  // spawning would turn a clear conflict into a startup timeout.
  if ((await probePort(options.port)) === "open") {
    const health = await serverHealth(options.port);
    if (health === undefined) throw portUnavailable(options.port);
    if (health.version === CLI_VERSION) return;
    // `start` is the command that spawns servers, so `start` is where a stale
    // one is replaced rather than reported: an agent told to run `stop` here
    // would spend a turn on a decision this command has already made. Waiting
    // polls reconnect on their own while the port answers again.
    await shutDownStale(options.port);
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

/**
 * The old server, asked to go. Its own `/api/shutdown` answers before it stops
 * listening, so the port is polled until it is really free — spawning into a
 * port the outgoing process still holds is the one way to turn a clean replace
 * into a startup timeout.
 */
async function shutDownStale(port: number): Promise<void> {
  await requestShutdown(port);
  const deadline = Date.now() + STALE_SHUTDOWN_MS;
  while (Date.now() < deadline) {
    if ((await probePort(port)) !== "open") return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
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

/**
 * The handshake for every command that talks to a server it did not start. A
 * `serve` left running from an older install answers `/health` and speaks a
 * protocol this CLI no longer reads — it sent no `turn` and no `round`, and the
 * client filled both in with defaults, so the agent read an invented turn off a
 * server that had never heard of turns. Nothing is assumed here: the command
 * stops before it blocks, and names what clears it.
 *
 * A port with nothing on it is not this function's business — `longPoll` and
 * `apiRequest` diagnose that, with the retries that tell a dead server from a
 * slow one.
 */
export async function assertServerCurrent(port: number, target: string): Promise<void> {
  const health = await serverHealth(port);
  if (health === undefined || health.version === CLI_VERSION) return;
  throw new ReviewError({
    code: "server_stale",
    message: `the review server on port ${port} is version ${health.version ?? "older than 1.2.0"}, this CLI is ${CLI_VERSION}`,
    detail:
      "it answers a protocol this CLI no longer reads — an older server sends no `turn`" +
      " and no `round`, which are the facts every command is chosen against",
    suggestions: [
      "Run `lightspeed stop` to shut the old server down",
      `Then re-run \`lightspeed wait ${target}\`; the next \`start\` brings this version up`,
    ],
  });
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
