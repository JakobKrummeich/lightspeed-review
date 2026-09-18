import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import type { TurnFacts } from "../turn.ts";
import { apiRequest } from "./api-client.ts";
import { serverOrigin } from "./server-address.ts";
import { helpReopen } from "./home.ts";

export interface EndInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
}

/**
 * Agent-initiated close: the review is over without waiting for a reviewer.
 * Never gated on the turn — ending is the one move both sides can always make,
 * and an agent that cannot end a review it opened is an agent that leaks them.
 */
export async function runEnd(input: EndInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const closed = (await apiRequest(
    `${serverOrigin(input.port)}/api/session/${key}/end`,
    { method: "POST" },
    key,
  )) as Partial<TurnFacts>;
  const target = `${input.branch} ${input.base}`;
  return {
    ...(closed.turn === undefined ? {} : { turn: closed.turn }),
    ...(closed.round === undefined ? {} : { round: closed.round }),
    session: { key, branch: input.branch, base: input.base, status: "ended" },
    message: "the review session is closed; the browser shows it as ended",
    help: [helpReopen(target)],
  };
}
