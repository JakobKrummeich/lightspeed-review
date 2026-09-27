import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

/**
 * A port nothing listens on: nothing in the suite ever binds it, and no normal
 * machine runs a service on it, so a command pointed here finds no server —
 * never the machine's real one. Not because it is privileged: root, Docker
 * 20.10+ and macOS 10.14+ all let an ordinary process bind it.
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
 * A port for a server that does not exist yet, and that stays this test
 * process's after its server is gone. Only for a test that needs the number
 * before anything listens on it, or needs it to stay free after a server
 * stops. Everywhere else, listen on port 0 and read the port back; for "no
 * server here", use NO_SERVER_PORT.
 *
 * Why not listen on 0, read the port and close (what this did through 3.6.0):
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

/** EACCES is taken too: a sandbox or security policy may forbid a port that nothing holds. */
async function listenIfFree(port: number): Promise<Server | undefined> {
  const server = createServer();
  return await new Promise<Server | undefined>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      error.code === "EADDRINUSE" || error.code === "EACCES" ? resolve(undefined) : reject(error),
    );
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/**
 * A machine whose ephemeral range reaches into ours would bring the race back:
 * say so. Ports reserved through ip_local_reserved_ports are never handed out
 * by the kernel, so an overlap they cover is no overlap.
 */
function assertOutsideEphemeralRange(): void {
  const range = "/proc/sys/net/ipv4/ip_local_port_range";
  if (!existsSync(range)) return;
  const [low = 0, high = 0] = readFileSync(range, "utf8").trim().split(/\s+/).map(Number);
  const reserved = reservedPorts();
  for (let port = Math.max(low, FIRST_PORT); port <= Math.min(high, LAST_CLAIM); port += 1) {
    if (reserved.some(([from, to]) => port >= from && port <= to)) continue;
    throw new Error(
      `freePort: the ephemeral range ${low}..${high} overlaps ${FIRST_PORT}..${LAST_CLAIM}; ` +
        "narrow net.ipv4.ip_local_port_range, reserve the block through " +
        "net.ipv4.ip_local_reserved_ports, or move FIRST_PORT out of the range",
    );
  }
}

/** `net.ipv4.ip_local_reserved_ports` as ranges: "20000-31999,40000" reads as [[20000, 31999], [40000, 40000]]. */
function reservedPorts(): [number, number][] {
  const path = "/proc/sys/net/ipv4/ip_local_reserved_ports";
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(",")
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [from = 0, to = from] = entry.split("-").map(Number);
      return [from, to];
    });
}

export interface OccupiedPort {
  port: number;
  release(): Promise<void>;
}

/** A plain TCP listener that never speaks HTTP: the "someone else" case. On port 0, held until released. */
export async function occupyPort(): Promise<OccupiedPort> {
  const accepted: Socket[] = [];
  const squatter = createServer((socket) => accepted.push(socket));
  await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  return {
    port: (squatter.address() as AddressInfo).port,
    release: async () => {
      // Sockets opened by health probes would hold `close` open forever.
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    },
  };
}
