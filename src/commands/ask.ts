import type { PollPayload } from "../feedback.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { longPoll } from "./long-poll.ts";
import { parseVerb, type VerbArgs } from "./verb-args.ts";
import { serverOrigin } from "./server-address.ts";
import { waitOutput } from "./wait.ts";

export interface AskInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  question: string;
}

export function parseAskArgs(args: string[]): VerbArgs {
  return parseVerb(
    args,
    { verb: "ask", placeholder: "question" },
    "the question to put to the reviewer",
  );
}

/**
 * Blocks on the same wait every delivery comes through: an agent should be able
 * to ask something before it starts editing, without inventing a protocol for
 * the answer.
 */
export async function runAsk(input: AskInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const origin = serverOrigin(input.port);
  const target = `${input.branch} ${input.base}`;
  await apiRequest(
    `${origin}/api/session/${key}/reply`,
    jsonPost({ comment: input.question, kind: "question" }),
    { key, target },
  );
  const result = (await longPoll({
    origin,
    key,
    target,
    port: input.port,
  })) as PollPayload;
  return waitOutput(result, { ...input, asked: input.question });
}
