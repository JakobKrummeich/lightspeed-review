import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { turnBlock, type TurnFacts } from "../turn.ts";
import { apiRequest } from "./api-client.ts";
import { serverOrigin } from "./server-address.ts";
import { legalMoves } from "./home.ts";

export interface EndInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
}

/**
 * Never gated on the turn: ending is the one move both sides can always make,
 * and an agent that cannot end a review it opened is an agent that leaks them.
 */
export async function runEnd(input: EndInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const target = `${input.branch} ${input.base}`;
  const closed = (await apiRequest(
    `${serverOrigin(input.port)}/api/session/${key}/end`,
    { method: "POST" },
    { key, target },
  )) as Partial<TurnFacts>;
  return {
    ...turnBlock(closed),
    // No `status`: `turn: ended` above is the same fact, said once.
    session: { key, branch: input.branch, base: input.base },
    message: "the review session is closed; the browser shows it as ended",
    help: legalMoves("ended", target),
  };
}
