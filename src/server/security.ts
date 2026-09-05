/**
 * What keeps a loopback-only server loopback-only: the Host check against DNS
 * rebinding and the Origin check against cross-site request forgery.
 */
import type { IncomingMessage } from "node:http";

/**
 * Only requests that name this loopback server are served: a browser page on
 * another origin must not be able to reach the review API by DNS rebinding.
 */
export function hostIsAllowed(request: IncomingMessage): boolean {
  const header = request.headers.host;
  if (header === undefined) return false;
  return isLoopback(header.split(":")[0]);
}

/**
 * The Host check alone does not stop cross-site POSTs (the browser sets Host):
 * without this, any site the reviewer visits could forge feedback into the
 * agent's prompt stream or shut the server down. No Origin = CLI client, which
 * browsers cannot impersonate.
 */
export function originIsAllowed(request: IncomingMessage, currentPort: number): boolean {
  const header = request.headers.origin;
  if (header === undefined) return true;
  let origin: URL;
  try {
    origin = new URL(header);
  } catch {
    return false;
  }
  return isLoopback(origin.hostname) && origin.port === String(currentPort);
}

function isLoopback(hostname: string | undefined): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}
