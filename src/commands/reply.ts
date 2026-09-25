import { invocationError } from "../errors.ts";
import type { AgentNote } from "../feedback.ts";
import { branchState } from "../git-state.ts";
import { printBlock, type StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { turnBlock, type TurnFacts } from "../turn.ts";
import { ifKilled, replyRerun, waitClause } from "../turn-help.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { scanArgs } from "./args.ts";
import { listen, type ListenInput } from "./listen.ts";
import { serverOrigin } from "./server-address.ts";
import { branchAndBase, takeToPairs } from "./to-args.ts";

export interface ReplyArgs {
  notes: AgentNote[];
  branch: string | undefined;
  base: string | undefined;
}

export interface ReplyInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  notes: AgentNote[];
  /** Where what landed is shown before the wait begins. */
  announce?: (block: StructuredOutput) => void;
  /** The wait; tests stub it so a reply can be posted without a reviewer. */
  listen?: (input: ListenInput) => Promise<StructuredOutput>;
}

export function parseReplyArgs(args: string[]): ReplyArgs {
  const { notes, rest } = takeToPairs(args, "reply");
  const scanned = scanArgs(rest, {
    onUnknown: (flag) =>
      invocationError("unknown_flag", `unknown flag ${flag}`, [
        "Known here: --to <id> '<text>', repeated once per item",
        "Run `lightspeed reply --help` for what it takes",
      ]),
  });
  // A reply with nothing to say isn't a reply (D1): refused before anything is sent.
  if (notes.length === 0) {
    throw invocationError("argument_missing", "reply needs at least one --to <id> '<text>'", [
      "Run `lightspeed reply --to t1 '<answer>' [--to main '<text>'] [branch] [base]`",
      "Nothing to say and something to change? Run `lightspeed work '<plan>'` instead",
    ]);
  }
  return { notes, ...branchAndBase(scanned.positional, "reply") };
}

/**
 * Every answer of the turn in one call, each under its item, then the turn is
 * the reviewer's and this waits for their next Send. The branch tip and tree
 * state go along because a reply from `working` is legal only while nothing
 * has changed since `work` (W2) — which only this side can see.
 */
export async function runReply(input: ReplyInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const target = `${input.branch} ${input.base}`;
  const state = branchState(input.repoRoot, input.branch);
  const answer = (await apiRequest(
    `${serverOrigin(input.port)}/api/session/${key}/reply`,
    jsonPost({ replies: input.notes, ...state }),
    { key, target },
  )) as Partial<TurnFacts> & { rerun?: boolean };
  const announce = input.announce ?? printBlock;
  announce(landed(answer, input.notes, target));
  return await (input.listen ?? listen)(input);
}

function landed(
  answer: Partial<TurnFacts> & { rerun?: boolean },
  notes: AgentNote[],
  target: string,
): StructuredOutput {
  const said =
    answer.rerun === true
      ? {
          rerun: true,
          message: `already replied; nothing posted twice — ${waitClause(answer.turn)}`,
        }
      : {
          replied: [...new Set(notes.map((note) => note.to))],
          message: `replied; ${waitClause(answer.turn)}`,
        };
  return { ...turnBlock(answer), ...said, ...ifKilled(replyRerun(target, notes)) };
}
