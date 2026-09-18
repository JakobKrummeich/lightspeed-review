import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { turnBlock, type TurnFacts } from "../turn.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { helpNextRound, helpSay, helpWait } from "./home.ts";
import { parseVerb, type VerbArgs } from "./verb-args.ts";
import { serverOrigin } from "./server-address.ts";

export interface WorkInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  plan: string;
}

export function parseWorkArgs(args: string[]): VerbArgs {
  return parseVerb(args, { verb: "work" }, "the plan you are about to go quiet over");
}

/**
 * Declares the silence. The turn is already the agent's — `work` does not take
 * it, it only says what is being done with it — so the reviewer's banner stops
 * saying "the agent has your feedback" and names the plan instead. Nothing here
 * blocks: the agent says it and goes and edits.
 */
export async function runWork(input: WorkInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const declared = (await apiRequest(
    `${serverOrigin(input.port)}/api/session/${key}/work`,
    jsonPost({ plan: input.plan }),
    key,
  )) as Partial<TurnFacts> & { changed?: boolean };
  const target = `${input.branch} ${input.base}`;
  return {
    ...turnBlock(declared),
    plan: input.plan,
    // Redeclaring the same plan is legal and changes nothing; saying so keeps an
    // agent from reading a second `work` as a second thing it did.
    message:
      declared.changed === false
        ? "the reviewer's banner already named this plan (no-op)"
        : "the reviewer's banner names this plan until you speak again",
    help: [helpSay(target), helpNextRound(target), helpWait(target)],
  };
}
