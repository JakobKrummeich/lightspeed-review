import type { StructuredOutput } from "../output.ts";
import { serverOrigin } from "./server-address.ts";
import { HELP_START } from "./home.ts";

export interface StopInput {
  port: number;
}

/** Shuts the background server down. Already stopped is success, not an error:
 * the caller asked for a state, not for an event. */
export async function runStop(input: StopInput): Promise<StructuredOutput> {
  const running = await requestShutdown(input.port);
  return {
    server: { port: input.port, status: running ? "stopped" : "not_running" },
    message: running
      ? "the review server was shut down; open sessions stay on disk"
      : `no review server was listening on port ${input.port}`,
    help: [HELP_START],
  };
}

/** False means nothing was listening — the desired end state either way. */
async function requestShutdown(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${serverOrigin(port)}/api/shutdown`, { method: "POST" });
    return response.ok;
  } catch {
    return false;
  }
}
