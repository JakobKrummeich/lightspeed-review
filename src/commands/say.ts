import type { CommentDeclaration } from "../declarations.ts";
import { validationError } from "../errors.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { turnBlock, type TurnFacts } from "../turn.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { lastValue } from "./args.ts";
import { turnHelp } from "./home.ts";
import { parseVerb, type VerbArgs } from "./verb-args.ts";
import { serverOrigin } from "./server-address.ts";

export interface SayArgs extends VerbArgs {
  /** `--for <id>`: the comment this answers, by the id `wait` printed with it. */
  for: string | undefined;
  /** `--files a,b`: the paths that comment led to changes in. */
  files: string[];
}

export interface SayInput {
  repoRoot: string;
  branch: string;
  base: string;
  port: number;
  text: string;
  for?: string;
  files?: string[];
}

const SAY_FLAGS = ["--for", "--files"] as const;

export function parseSayArgs(args: string[]): SayArgs {
  const parsed = parseVerb(args, { verb: "say", value: SAY_FLAGS }, "something to say");
  const pinned = lastValue(parsed.scanned, "--for");
  const files = splitFiles(lastValue(parsed.scanned, "--files"));
  // Files without an id name changes belonging to no comment: the between-round
  // diff already says what moved, so the list would answer a question nobody asked.
  if (files.length > 0 && pinned === undefined) {
    throw validationError("--files needs the --for it describes", [
      'Run `lightspeed say "<answer>" --for <id> --files <a,b>` with the id `wait` printed',
    ]);
  }
  return { ...parsed, for: pinned, files };
}

function splitFiles(value: string | undefined): string[] {
  if (value === undefined) return [];
  const files = value
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path !== "");
  if (files.length === 0) {
    throw validationError("--files needs a comma-separated list of paths", [
      'Run `lightspeed say "<answer>" --for <id> --files src/api/users.ts,src/db.ts`',
    ]);
  }
  return files;
}

/**
 * Speech that costs nothing. It does not block and it does not move the turn:
 * an agent that answers one comment and keeps editing is still editing, and a
 * Send that flickered on between its sentences would be worse than one that
 * stays off. `--for` pins the whole answer under the comment it answers, where
 * the reviewer is already looking, instead of adding a line to the conversation
 * they have to match up themselves.
 */
export async function runSay(input: SayInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const declarations = pinned(input);
  const answered = (await apiRequest(
    `${serverOrigin(input.port)}/api/session/${key}/reply`,
    jsonPost({
      ...(declarations.length === 0 ? { comment: input.text } : { declarations }),
    }),
    key,
  )) as Partial<TurnFacts>;
  const target = `${input.branch} ${input.base}`;
  return {
    ...turnBlock(answered),
    said: input.text,
    ...(input.for === undefined ? {} : { for: input.for }),
    ...(input.files === undefined || input.files.length === 0 ? {} : { files: input.files }),
    // Speaking moves nothing, so the moves that were legal before it still are.
    // A server too old to state a turn predates the turn itself: `wait` was the
    // only way to get one there, which is what the reviewer's turn offers.
    help: turnHelp(answered.turn ?? "reviewer", target, answered.helpForm),
  };
}

function pinned(input: SayInput): CommentDeclaration[] {
  if (input.for === undefined) return [];
  return [{ id: input.for, note: input.text, files: input.files ?? [] }];
}
