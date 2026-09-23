/**
 * The grammar the agent's speaking verbs share:
 *
 *   lightspeed <verb> "<message>" [branch] [base] [flags]
 *
 * The message is a positional and never a flag: a verb whose subject hides
 * behind `--something` reads as optional.
 */
import { invocationError } from "../errors.ts";
import { scanArgs, type ScannedArgs } from "./args.ts";

export interface VerbSpec {
  verb: string;
  value?: readonly string[];
  boolean?: readonly string[];
  /**
   * Worded the same here and in `--help`: `ask` once asked for a `<text>` in its
   * error and a `<question>` in its help, which is two names for one argument.
   */
  placeholder?: string;
}

export interface VerbArgs {
  message: string;
  /** Unset when the agent left it to `resolveSession` to work out. */
  branch: string | undefined;
  base: string | undefined;
  scanned: ScannedArgs;
}

/**
 * Unknown flags are loud: one read as the message would put `--flu` in front of
 * the reviewer, and one read as a branch would speak into the wrong review — or
 * none.
 */
export function parseVerb(args: string[], spec: VerbSpec, wanted: string): VerbArgs {
  const scanned = scanArgs(args, {
    value: spec.value,
    boolean: spec.boolean,
    onUnknown: (flag) => unknownFlag(spec, flag),
  });
  return {
    message: requireMessage(spec, scanned.positional[0], wanted),
    branch: scanned.positional[1],
    base: scanned.positional[2],
    scanned,
  };
}

function unknownFlag(spec: VerbSpec, flag: string): Error {
  const known = [...(spec.value ?? []), ...(spec.boolean ?? [])];
  return invocationError("unknown_flag", `unknown flag ${flag}`, [
    known.length === 0
      ? `\`lightspeed ${spec.verb}\` takes no flags`
      : `Known here: ${known.join(", ")}`,
    `Run \`lightspeed ${spec.verb} --help\` for what it takes`,
  ]);
}

/**
 * An empty message is the same mistake as a missing one: a blank line in the
 * conversation is a turn the reviewer cannot read.
 */
function requireMessage(spec: VerbSpec, message: string | undefined, wanted: string): string {
  if (message !== undefined && message.trim() !== "") return message;
  throw invocationError("argument_missing", `${spec.verb} needs ${wanted}`, [
    `Run \`lightspeed ${spec.verb} "<${spec.placeholder ?? "text"}>" [branch] [base]\``,
    `Run \`lightspeed ${spec.verb} --help\` for two examples`,
  ]);
}
