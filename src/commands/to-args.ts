/**
 * `--to <id> "<text>"`: the one flag that takes two values, so it is read off
 * the command line before the ordinary scan — which would take the text for a
 * branch. Shared by `reply` and `publish`, the two verbs that post into threads.
 */
import { invocationError } from "../errors.ts";
import type { AgentNote } from "../feedback.ts";

export interface ToArgs {
  notes: AgentNote[];
  /** Everything that was not a `--to` pair, in order, for the ordinary scan. */
  rest: string[];
}

export function takeToPairs(args: string[], verb: string): ToArgs {
  const notes: AgentNote[] = [];
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token !== "--to") {
      rest.push(token);
      continue;
    }
    notes.push(pairAt(args, index, verb));
    index += 2;
  }
  return { notes, rest };
}

/**
 * Both halves or an error at the flag: a `--to` that swallowed the next flag
 * as its text would post `--to` to the reviewer.
 */
function pairAt(args: string[], index: number, verb: string): AgentNote {
  const to = args[index + 1];
  const text = args[index + 2];
  if (to === undefined || to.startsWith("--") || text === undefined || text.trim() === "") {
    throw invocationError(
      "argument_missing",
      '--to needs an item id and the text for it: --to <id> "<text>"',
      [
        `Run \`lightspeed ${verb} --to t1 '<text>' [--to main '<text>'] [branch] [base]\``,
        "Item ids are the `id` of each item the last batch printed; `main` is the main chat",
      ],
    );
  }
  return { to, text };
}
