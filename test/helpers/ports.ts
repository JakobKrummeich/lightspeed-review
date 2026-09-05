import { createServer, type Socket } from "node:net";

/**
 * A port nothing is listening on right now. "Is a server running?" tests need
 * a real port, not the port-0 trick: the question predates the server.
 */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
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
