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

/** Whether the thing on the port is ours. `/health` is the whole test; the request
 * is bounded because a non-HTTP process holding the port would wait forever. */
export async function reviewServerIsUp(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${serverOrigin(port)}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
