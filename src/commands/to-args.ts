/**
 * `--to <id> "<text>"`: the one flag that takes two values, so it is read off
 * the command line before the ordinary scan — which would take the text for a
 * branch. Shared by `reply` and `publish`, the two verbs that post into threads.
 */
import { ReviewError, invocationError } from "../errors.ts";
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
  if (to === undefined || to.startsWith("--")) throw pairMissing(verb);
  if (text?.startsWith("--") === true) throw textIsAFlag(verb, to, text);
  if (text === undefined || text.trim() === "") throw pairMissing(verb);
  return { to, text };
}

function pairMissing(verb: string): ReviewError {
  return invocationError(
    "argument_missing",
    '--to needs an item id and the text for it: --to <id> "<text>"',
    [
      `Run \`lightspeed ${verb} --to <id> '<text>' [--to main '<text>'] [branch] [base]\``,
      "Item ids are the `id` of each item the last batch printed; `main` is the main chat",
    ],
  );
}

function textIsAFlag(verb: string, to: string, flag: string): ReviewError {
  return invocationError(
    "argument_missing",
    `--to ${to} has no text: the next word is the flag ${flag}`,
    [
      `Quote the words: \`lightspeed ${verb} --to ${to} '<text>' …\``,
      "A text that really starts with -- reads as a flag; reword it",
    ],
  );
}

/**
 * What is left after the pairs and the flags is the session: at most a branch
 * and a base. More means words the shell split — an unquoted `--to` text —
 * and reading them as a branch would post half a sentence to the wrong review.
 */
export function branchAndBase(
  positional: string[],
  verb: string,
): { branch: string | undefined; base: string | undefined } {
  if (positional.length > 2) {
    throw new ReviewError({
      code: "invalid_arguments",
      message: `${verb} got more than a branch and a base: ${positional.join(" ")}`,
      detail: "an unquoted --to text is split by the shell into words that read as extra arguments",
      suggestions: [
        `Quote each text: \`lightspeed ${verb} --to <id> '<several words>' [branch] [base]\``,
      ],
    });
  }
  return { branch: positional[0], base: positional[1] };
}
