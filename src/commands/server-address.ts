import { connect } from "node:net";

/** The review server binds loopback only, so this is the only address it has. */
export function serverOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** What a TCP connection found. `refused` alone proves nothing is listening —
 * everything else means a command must not tell the agent to start another server. */
export type PortState = "open" | "refused" | "unreachable";

const CONNECT_TIMEOUT_MS = 1_000;
const HEALTH_TIMEOUT_MS = 1_000;
/** Waits between probes; the last entry is how long a verdict takes to reach. */
const PROBE_BACKOFF_MS = [50, 100, 200, 400, 800];

/** Whether anything at all accepts a connection on the port, right now. */
export async function probePort(port: number): Promise<PortState> {
  return await new Promise<PortState>((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const settle = (state: PortState) => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => settle("unreachable"));
    socket.once("connect", () => settle("open"));
    socket.once("error", (error) =>
      settle((error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "refused" : "unreachable"),
    );
  });
}

/** The port's state, believed only once it stops changing. One refused connection
 * is a moment, not a diagnosis (a restart, a busy machine) — calling it "no server"
 * is the mistake this module exists to stop. Every caller turning a failure into an
 * error code comes through here, so all wait the same ~1.5s before saying it. */
export async function diagnosePort(
  port: number,
  backoffMs: number[] = PROBE_BACKOFF_MS,
): Promise<PortState> {
  let state = await probePort(port);
  for (const delay of backoffMs) {
    if (state === "open") return state;
    await new Promise((resolve) => setTimeout(resolve, delay));
    state = await probePort(port);
  }
  return state;
}

/** What `/health` says about the server on the port. `version` is absent from
 * one old enough not to state it — which is itself the answer. */
export interface ServerHealth {
  version?: string;
}

/**
 * The server on the port, if it is ours. `/health` is the whole test; the
 * request is bounded because a non-HTTP process holding the port would wait
 * forever. `undefined` means "not our server", never "our server, unknown
 * version": the two lead to different commands.
 */
export async function serverHealth(port: number): Promise<ServerHealth | undefined> {
  try {
    const response = await fetch(`${serverOrigin(port)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    // An answer at all is the test for "ours", as it always was. The version is
    // read out of it where there is one: a server old enough not to state it is
    // exactly the server a caller needs to hear about, and calling it "not ours"
    // would send the agent to free a port that is not the problem.
    return response.ok ? { ...statedVersion(await response.text()) } : undefined;
  } catch {
    return undefined;
  }
}

function statedVersion(body: string): ServerHealth {
  try {
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === "string" ? { version: parsed.version } : {};
  } catch {
    return {};
  }
}

/** Whether the thing on the port is ours, whatever version it is. */
export async function reviewServerIsUp(port: number): Promise<boolean> {
  return (await serverHealth(port)) !== undefined;
}

/**
 * Shuts the server on the port down. False means nothing was listening — the
 * desired end state either way. Lives here rather than in `stop`, because a
 * stale server is replaced by the same request `stop` makes.
 */
export async function requestShutdown(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${serverOrigin(port)}/api/shutdown`, { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}
