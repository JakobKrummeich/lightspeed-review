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
  return parseVerb(args, { verb: "ask" }, "the question to put to the reviewer");
}

/**
 * Ask and listen in one line. The question goes into the conversation as a card
 * with its own answer box, the turn goes back to the reviewer so they can use
 * it, and the command blocks on the same wait every delivery comes through —
 * which is the point: an agent should be able to ask something before it starts
 * editing, without inventing a protocol for the answer.
 */
export async function runAsk(input: AskInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const origin = serverOrigin(input.port);
  await apiRequest(
    `${origin}/api/session/${key}/reply`,
    jsonPost({ comment: input.question, kind: "question" }),
    key,
  );
  const result = (await longPoll({
    url: `${origin}/api/poll?key=${key}`,
    key,
    port: input.port,
  })) as PollPayload;
  return waitOutput(result, input);
}
