import type { CommentDeclaration } from "../declarations.ts";
import { invocationError } from "../errors.ts";
import type { StructuredOutput } from "../output.ts";
import { sessionKey } from "../paths.ts";
import { turnBlock, type TurnFacts } from "../turn.ts";
import { turnHelp } from "../turn-help.ts";
import { apiRequest, jsonPost } from "./api-client.ts";
import { lastValue } from "./args.ts";
import { parseVerb, type VerbArgs } from "./verb-args.ts";
import { serverOrigin } from "./server-address.ts";

export interface SayArgs extends VerbArgs {
  for: string | undefined;
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
    throw invocationError("argument_missing", "--files needs the --for it describes", [
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
    throw invocationError("argument_missing", "--files needs a comma-separated list of paths", [
      'Run `lightspeed say "<answer>" --for <id> --files src/api/users.ts,src/db.ts`',
    ]);
  }
  return files;
}

/**
 * Does not move the turn: an agent that answers one comment and keeps editing
 * is still editing, and a Send that flickered on between its sentences would be
 * worse than one that stays off. `--for` pins the whole answer under the
 * comment it answers, where the reviewer is already looking, instead of a
 * conversation line they have to match up themselves.
 */
export async function runSay(input: SayInput): Promise<StructuredOutput> {
  const key = sessionKey(input.repoRoot, input.branch, input.base);
  const target = `${input.branch} ${input.base}`;
  const declarations = pinned(input);
  const answered = (await apiRequest(
    `${serverOrigin(input.port)}/api/session/${key}/reply`,
    jsonPost({
      ...(declarations.length === 0 ? { comment: input.text } : { declarations }),
    }),
    { key, target },
  )) as Partial<TurnFacts>;
  return {
    ...turnBlock(answered),
    said: input.text,
    ...(input.for === undefined ? {} : { for: input.for }),
    ...(input.files === undefined || input.files.length === 0 ? {} : { files: input.files }),
    // A server too old to state a turn predates the turn itself: `wait` was the
    // only way to get one there, which is what the reviewer's turn offers.
    help: turnHelp(answered.turn ?? "reviewer", target, answered.helpForm),
  };
}

function pinned(input: SayInput): CommentDeclaration[] {
  if (input.for === undefined) return [];
  return [{ id: input.for, note: input.text, files: input.files ?? [] }];
}
