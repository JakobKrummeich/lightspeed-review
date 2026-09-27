import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

/**
 * A port nothing listens on and no test can take: it is privileged, so a
 * command pointed here finds no server — never the machine's real one.
 */
export const NO_SERVER_PORT = 1;

/**
 * Handed-out ports are FIRST_PORT..FIRST_PORT+PORT_COUNT-1; the claim on each
 * sits PORT_COUNT above it. Both ranges end below 32768, where every default
 * ephemeral range begins (Linux 32768, macOS and Windows 49152).
 */
const FIRST_PORT = 20_000;
const PORT_COUNT = 6_000;
const LAST_CLAIM = FIRST_PORT + 2 * PORT_COUNT - 1;

/**
 * A port for a server that does not exist yet — "is a server running?" tests,
 * and a `lightspeed serve` a spawned CLI starts, both need the number first.
 * Where the test starts the server itself, listen on port 0 instead.
 *
 * Why not listen on 0, read the port and close (what this did until 3.6.0):
 * the port is released, so any bind(0) in a test file running concurrently —
 * `node --test` runs files in parallel, and most start servers on port 0 — can
 * be handed it before the test listens, which fails `EADDRINUSE`. Instead the
 * port comes from outside the kernel's ephemeral range, where no bind(0) and no
 * outgoing connection ever lands, and is claimed for the life of this process
 * by listening on its companion port: another test process finds the claim
 * held and moves on, and the kernel releases it when this process dies, so a
 * crashed run leaves nothing stale behind.
 */
export async function freePort(): Promise<number> {
  assertOutsideEphemeralRange();
  for (let port = FIRST_PORT; port < FIRST_PORT + PORT_COUNT; port += 1) {
    const claim = await listenIfFree(port + PORT_COUNT);
    if (claim === undefined) continue;
    claim.unref();
    // Held by something outside the suite: skip it, and keep the claim so no
    // other test process tries it again.
    const probe = await listenIfFree(port);
    if (probe === undefined) continue;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }
  throw new Error(`freePort: every port in ${FIRST_PORT}..${FIRST_PORT + PORT_COUNT - 1} is taken`);
}

async function listenIfFree(port: number): Promise<Server | undefined> {
  const server = createServer();
  return await new Promise<Server | undefined>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "EADDRINUSE" ? resolve(undefined) : reject(error),
    );
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** A machine whose ephemeral range reaches down into ours would bring the race back: say so. */
function assertOutsideEphemeralRange(): void {
  const range = "/proc/sys/net/ipv4/ip_local_port_range";
  if (!existsSync(range)) return;
  const [low = 0, high = 0] = readFileSync(range, "utf8").trim().split(/\s+/).map(Number);
  if (low <= LAST_CLAIM && high >= FIRST_PORT) {
    throw new Error(
      `freePort: the ephemeral range starts at ${low}, inside ${FIRST_PORT}..${LAST_CLAIM}; move FIRST_PORT below it`,
    );
  }
}

export interface OccupiedPort {
  release(): Promise<void>;
}

/** A plain TCP listener that never speaks HTTP: the "someone else" case. */
export async function occupyPort(port: number): Promise<OccupiedPort> {
  const accepted: Socket[] = [];
  const squatter = createServer((socket) => accepted.push(socket));
  await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  return {
    release: async () => {
      // Sockets opened by health probes would hold `close` open forever.
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    },
  };
}
