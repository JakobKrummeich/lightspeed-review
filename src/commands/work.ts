import { branchState } from "../git-state.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { turnBlock, type TurnFacts } from "../turn.ts";
import { nextRule } from "../turn-help.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
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
  return parseVerb(
    args,
    { verb: "work", placeholder: "plan" },
    "the plan you are about to carry out",
  );
}

/**
 * The discussion is over: the reviewer's header names the plan and they can
 * only Queue until `publish`. Waits for nothing — the agent has work to do.
 */
export async function runWork(input: WorkInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const target = `${input.branch} ${input.base}`;
  const { head, tree } = branchState(input.repoRoot, input.branch);
  const declared = (await apiRequest(
    `${serverOrigin(input.port)}/api/session/${key}/work`,
    jsonPost({ plan: input.plan, head, tree }),
    { key, target },
  )) as Partial<TurnFacts> & { changed?: boolean; open?: string[] };
  return {
    ...turnBlock(declared),
    plan: input.plan,
    // Redeclaring the same plan is legal and changes nothing; saying so keeps an
    // agent from reading a second `work` as a second thing it did.
    message:
      declared.changed === false
        ? "the reviewer's header already names this plan (no-op)"
        : "the reviewer's header names this plan; they can queue, not send, until you publish",
    next: nextRule(declared.turn ?? "agent working", target, declared.open ?? []),
  };
}
