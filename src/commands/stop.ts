import type { StructuredOutput } from "../output.ts";
import { HELP_START } from "../turn-help.ts";
import { requestShutdown } from "./server-address.ts";

export interface StopInput {
  port: number;
}

/** Already stopped is success, not an error: the caller asked for a state, not
 * for an event. */
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
