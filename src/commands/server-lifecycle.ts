import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { ReviewError } from "../errors.ts";
import { assertBundlePresent, DEFAULT_STATIC_DIR } from "../static-assets.ts";
import { CLI_VERSION } from "../version.ts";
import {
  probePort,
  requestShutdown,
  reviewServerIsUp,
  serverHealth,
  type ServerHealth,
} from "./server-address.ts";

export interface EnsureServerOptions {
  port: number;
  /** This CLI's: a server keeping its reviews anywhere else is refused, not reused. */
  stateDir: string;
  /** Injected in tests. */
  spawnServer?: () => void;
  timeoutMs?: number;
  staticDir?: string;
}

const READY_POLL_MS = 25;
const DEFAULT_TIMEOUT_MS = 10_000;

const STALE_SHUTDOWN_MS = 2_000;

/** The server outlives the command — that is what lets `open` hand out a URL
 * and exit. */
export async function ensureServerRunning(options: EnsureServerOptions): Promise<void> {
  // Checked before spawning: into a port something else holds, spawning would
  // turn a clear conflict into a startup timeout.
  if (await portIsHeldByCurrentServer(options.port, options.stateDir)) return;
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
 * A server of another version is shut down here rather than reported: `open`
 * is the command that spawns servers, so an agent told to run `stop` would
 * spend a turn on a decision this command has already made. Waiting polls
 * reconnect on their own once the port answers again.
 */
async function portIsHeldByCurrentServer(port: number, stateDir: string): Promise<boolean> {
  if ((await probePort(port)) !== "open") return false;
  const health = await serverHealth(port);
  if (health === undefined) throw portUnavailable(port);
  if (health.version !== CLI_VERSION) {
    await shutDownStale(port);
    return false;
  }
  assertSameStateDir(port, health, stateDir);
  return true;
}

/**
 * Asked before a command touches a review, because the answer decides what the
 * local session files mean: a server keeping its reviews elsewhere holds the
 * reviewer's Sends where this CLI never looks, so a missing file here proves
 * nothing and every answer read off one would be wrong. Nothing listening, or
 * something that is not ours, is not this function's business — the command's
 * own server calls diagnose those.
 */
export async function assertServerSharesState(port: number, stateDir: string): Promise<void> {
  if ((await probePort(port)) !== "open") return;
  const health = await serverHealth(port);
  if (health !== undefined) assertSameStateDir(port, health, stateDir);
}

/**
 * Refused rather than replaced, unlike a stale version: the other server may
 * be somebody's live review — another HOME, another harness — and stopping it
 * is a decision for whoever reads the error. A server too old to state its
 * directory is let through; `server_stale` speaks for it.
 */
function assertSameStateDir(port: number, health: ServerHealth, stateDir: string): void {
  if (health.stateDir === undefined || health.stateDir === resolve(stateDir)) return;
  throw new ReviewError({
    code: "server_state_mismatch",
    message: `the review server on port ${port} keeps its reviews in ${health.stateDir}, this CLI in ${resolve(stateDir)}`,
    detail:
      "they see different reviews: the reviewer's Sends land where this CLI never looks," +
      " so a review this CLI cannot find may still be live there",
    suggestions: [
      "Run `lightspeed stop` to shut that server down (its reviews stay on disk), then re-run this command; it brings up a server on this CLI's state dir",
      `Or set a free \`port\` in .lightspeed.conf.json instead of ${port} to keep both running`,
    ],
  });
}

/**
 * `/api/shutdown` answers before the server stops listening, so the port is
 * polled until it is really free — spawning into a port the outgoing process
 * still holds turns a clean replace into a startup timeout.
 */
async function shutDownStale(port: number): Promise<void> {
  await requestShutdown(port);
  const deadline = Date.now() + STALE_SHUTDOWN_MS;
  while (Date.now() < deadline) {
    if ((await probePort(port)) !== "open") return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

async function answersWithin(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    if (await reviewServerIsUp(port)) return true;
  }
  return false;
}

/**
 * A `serve` left running from an older install answers `/health` and speaks a
 * protocol this CLI no longer reads — it sent no `turn` and no `round`, the
 * client filled both in with defaults, and the agent read an invented turn off
 * a server that had never heard of turns. So the command stops before it
 * blocks. A port with nothing on it is not this function's business: `longPoll`
 * and `apiRequest` diagnose that, with the retries that tell a dead server from
 * a slow one.
 */
export async function assertServerCurrent(port: number, target: string): Promise<void> {
  const health = await serverHealth(port);
  if (health === undefined || health.version === CLI_VERSION) return;
  throw new ReviewError({
    code: "server_stale",
    message: `the review server on port ${port} is version ${health.version ?? "older than 2.0.0"}, this CLI is ${CLI_VERSION}`,
    detail:
      "it answers a protocol this CLI no longer reads — an older server sends no `turn`" +
      " and no `round`, which are the facts every command is chosen against",
    suggestions: [
      "Run `lightspeed stop` to shut the old server down",
      `Then re-run \`lightspeed open ${target}\`; it brings this version up and re-attaches to the review`,
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
