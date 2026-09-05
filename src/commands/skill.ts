import { ReviewError, validationError } from "../errors.ts";
import { isSkillAgent, renderSkillFor, SKILL_AGENTS } from "../skill.ts";
import { scanArgs } from "./args.ts";

export interface SkillInput {
  agent: string;
}

/** A document generator: stdout is redirected straight into the file the named
 * agent reads, so the answer is raw markdown — deliberately not TOON, no trailing
 * `help[]`. Failures are still TOON like every other command's. */
export function runSkill(input: SkillInput): string {
  const { agent } = input;
  if (!isSkillAgent(agent)) throw unknownAgent(agent);
  return renderSkillFor(agent);
}

export function parseSkillArgs(args: string[]): SkillInput {
  const scanned = scanArgs(args, {
    value: ["--agent"],
    // Fail loud: a silently ignored flag would print the pi dialect into another
    // agent's file with nothing on screen saying why.
    onUnknown: unknownSkillFlag,
    onMissingValue: missingAgentValue,
  });
  const positional = scanned.positional[0];
  if (positional !== undefined) throw positionalAgent(positional);
  return { agent: scanned.flags.at(-1)?.value ?? "pi" };
}

function unknownAgent(agent: string): ReviewError {
  return new ReviewError({
    code: "invalid_arguments",
    message: `\`${agent}\` is not an agent skill can render for`,
    detail: `supported: ${SKILL_AGENTS.join(", ")}`,
    suggestions: [
      "Run `lightspeed skill --agent <id>` with one of the ids above",
      "Run `lightspeed skill --help` for where each agent's file lives",
    ],
  });
}

function unknownSkillFlag(flag: string): Error {
  return validationError(`unknown flag ${flag}`, [
    "Known here: --agent",
    "Run `lightspeed skill --help` for what it does",
  ]);
}

function missingAgentValue(flag: string): Error {
  return validationError(`${flag} needs a value`, [`Say which agent: ${SKILL_AGENTS.join(", ")}`]);
}

function positionalAgent(token: string): ReviewError {
  return new ReviewError({
    code: "invalid_arguments",
    message: "skill takes no positional arguments",
    detail: `agents are named with --agent: ${SKILL_AGENTS.join(", ")}`,
    suggestions: [`Run \`lightspeed skill --agent ${token}\``],
  });
}
