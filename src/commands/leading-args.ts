import { invocationError, type ReviewError } from "../errors.ts";

/**
 * What the command line says before a command is dispatched: read off argv by
 * `src/cli.ts` ahead of the SDK. Kept out of cli.ts, which runs the CLI the
 * moment it is imported, so these rules can be tested without spawning it.
 */

/**
 * Translated into the flag rather than registered as a command, so there is
 * one help text and `help open` is `open --help` exactly — including the
 * unknown-command error a name that is not a command still earns.
 */
export function withHelpAlias(given: string[]): string[] {
  if (given[0] !== "help") return given;
  const [, name] = given;
  return name === undefined ? ["--help"] : [name, "--help"];
}

/**
 * The SDK refuses a flag before the command in prose of its own, under its own
 * code; answered here instead, so `lightspeed --bogus` parses like every other
 * failure.
 */
export function leadingFlagProblem(given: string[]): ReviewError | undefined {
  const [flag] = given;
  if (flag === undefined || !flag.startsWith("-")) return undefined;
  if (given.length === 1 && ALONE_FLAGS.includes(flag)) return undefined;
  return invocationError(
    "unknown_flag",
    ALONE_FLAGS.includes(flag)
      ? `${flag} is read only on its own, with no command after it`
      : `unknown flag ${flag}`,
    [
      "Flags come after the command: `lightspeed <command> [args] [flags]`",
      "Run `lightspeed --help` for the commands, or `lightspeed` for this repository's reviews",
    ],
    `before a command only ${LEADING_FLAGS.join(", ")} are read`,
  );
}

const LEADING_FLAGS = ["--all", "--help", "--version"];

/** One list for both questions: when the alone-check and the refusal each had
 * their own, `-v open` was answered "unknown flag -v". The SDK reads `-v` and
 * `-V` as `--version`; the refusal's detail names only the long spellings. */
const ALONE_FLAGS = [...LEADING_FLAGS, "-v", "-V"];
