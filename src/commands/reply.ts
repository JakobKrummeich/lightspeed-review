import { invocationError } from "../errors.ts";
import type { AgentNote } from "../feedback.ts";
import { branchState } from "../git-state.ts";
import { printBlock, type StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import type { ReplyAnswer } from "../api-contract.ts";
import { turnBlock } from "../turn.ts";
import { ifKilled, replyRerun, urlLast, waitClause } from "../turn-help.ts";
import { callApi } from "./api-client.ts";
import { scanArgs } from "./args.ts";
import { listen, type ListenInput } from "./listen.ts";
import { reviewUrl, serverOrigin } from "./server-address.ts";
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
  const answer = await callApi(
    serverOrigin(input.port),
    "POST /api/session/:key/reply",
    { key },
    { replies: input.notes, ...state },
    { key, target },
  );
  const announce = input.announce ?? printBlock;
  announce(urlLast(landed(answer, input.notes, target), reviewUrl(input.port, key)));
  return await (input.listen ?? listen)(input);
}

function landed(answer: ReplyAnswer, notes: AgentNote[], target: string): StructuredOutput {
  const said =
    "rerun" in answer
      ? {
          rerun: true,
          message: `already replied; nothing posted twice — ${waitClause(answer.turn)}`,
        }
      : {
          replied: [...new Set(notes.map((note) => note.to))],
          message: `replied; ${waitClause(answer.turn)}`,
        };
  return { ...turnBlock(answer), ...said, ...ifKilled(answer.turn, replyRerun(target, notes)) };
}
