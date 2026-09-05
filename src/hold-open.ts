/** How often an idle long poll's connection is proved alive at the TCP level. */
export const KEEPALIVE_PROBE_MS = 15_000;

/** The two calls this needs, so a test can watch them being made. */
export interface HoldableSocket {
  setTimeout(ms: number): unknown;
  setKeepAlive(enable: boolean, initialDelay: number): unknown;
}

/**
 * A wait of unknown length: no idle timeout, TCP keepalive so a silent
 * connection stays known-alive to both ends. Both halves of the long poll use
 * it — either end letting go ends the wait.
 */
export function holdSocketOpen(socket: HoldableSocket): void {
  socket.setTimeout(0);
  socket.setKeepAlive(true, KEEPALIVE_PROBE_MS);
}
