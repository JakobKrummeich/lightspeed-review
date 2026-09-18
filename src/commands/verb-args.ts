/**
 * The grammar the agent's speaking verbs share: what it has to say comes first,
 * the session it is saying it about follows.
 *
 *   lightspeed <verb> "<message>" [branch] [base] [flags]
 *
 * The message is a positional and never a flag, because it is the point of the
 * command — a verb whose subject hides behind `--something` reads as optional.
 * Branch and base resolve exactly as they do everywhere else when omitted.
 */
import { validationError } from "../errors.ts";
import { scanArgs, type ScannedArgs } from "./args.ts";

export interface VerbSpec {
  /** The command's own name, for its errors and its `--help` pointer. */
  verb: string;
  /** Flags that consume the next token as their value. */
  value?: readonly string[];
  /** Flags that stand alone. */
  boolean?: readonly string[];
}

/** What every speaking verb reads off its command line. */
export interface VerbArgs {
  message: string;
  /** Unset when the agent left it to `resolveSession` to work out. */
  branch: string | undefined;
  base: string | undefined;
  scanned: ScannedArgs;
}

/**
 * Scans a verb's line and takes the message off the front. Unknown flags are
 * loud: one read as the message would put `--flu` in front of the reviewer, and
 * one read as a branch would speak into the wrong review — or none.
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
  return validationError(`unknown flag ${flag}`, [
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
  throw validationError(`${spec.verb} needs ${wanted}`, [
    `Run \`lightspeed ${spec.verb} "<${spec.verb === "work" ? "plan" : "text"}>" [branch] [base]\``,
    `Run \`lightspeed ${spec.verb} --help\` for two examples`,
  ]);
}
