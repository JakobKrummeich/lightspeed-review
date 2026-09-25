import { invocationError } from "../errors.ts";
import { branchState } from "../git-state.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { turnBlock, type TurnFacts } from "../turn.ts";
import { nextRule } from "../turn-help.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { scanArgs } from "./args.ts";
import { serverOrigin } from "./server-address.ts";

export interface WorkInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  plan: string;
}

export interface WorkArgs {
  message: string;
  /** Unset when the agent left it to `resolveSession` to work out. */
  branch: string | undefined;
  base: string | undefined;
}

/**
 * `lightspeed work '<plan>' [branch] [base]`. The plan is a positional, never a
 * flag: a subject behind `--something` reads as optional. Unknown flags are
 * loud: one read as the plan would put `--flu` in the reviewer's header, and one
 * read as a branch would declare work on the wrong review — or none.
 */
export function parseWorkArgs(args: string[]): WorkArgs {
  const { positional } = scanArgs(args, {
    onUnknown: (flag) =>
      invocationError("unknown_flag", `unknown flag ${flag}`, [
        "`lightspeed work` takes no flags",
        "Run `lightspeed work --help` for what it takes",
      ]),
  });
  const [message, branch, base] = positional;
  // A blank plan is the same mistake as a missing one: the header would name nothing.
  if (message === undefined || message.trim() === "") {
    throw invocationError("argument_missing", "work needs the plan you are about to carry out", [
      `Run \`lightspeed work "<plan>" [branch] [base]\``,
      "Run `lightspeed work --help` for two examples",
    ]);
  }
  return { message, branch, base };
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
