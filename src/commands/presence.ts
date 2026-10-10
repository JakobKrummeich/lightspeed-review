import type { CliRoutes } from "../api-contract.ts";
import { serverOrigin } from "./server-address.ts";

/** Short: `lightspeed` alone must answer at once, server or no server. */
const PRESENCE_TIMEOUT_MS = 800;

/**
 * Whether a waiting command is parked on the session right now. Only the server
 * can say — the store knows turns, not sockets — and a server that is down, or
 * does not know the session, has nobody listening.
 */
export async function listening(port: number, key: string): Promise<boolean> {
  try {
    const response = await fetch(`${serverOrigin(port)}/api/session/${key}/presence`, {
      signal: AbortSignal.timeout(PRESENCE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const answer = (await response.json()) as Partial<
      CliRoutes["GET /api/session/:key/presence"]["answer"]
    >;
    return answer.waiting === true;
  } catch {
    return false;
  }
}
