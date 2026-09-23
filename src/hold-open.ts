export const KEEPALIVE_PROBE_MS = 15_000;

/** The two calls this needs, so a test can watch them being made. */
export interface HoldableSocket {
  setTimeout(ms: number): unknown;
  setKeepAlive(enable: boolean, initialDelay: number): unknown;
}

/**
 * No idle timeout: the wait is of unknown length. TCP keepalive so a silent
 * connection stays known-alive to both ends.
 */
export function holdSocketOpen(socket: HoldableSocket): void {
  socket.setTimeout(0);
  socket.setKeepAlive(true, KEEPALIVE_PROBE_MS);
}
