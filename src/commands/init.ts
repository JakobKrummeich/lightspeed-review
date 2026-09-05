import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILENAME, STARTER_CONFIG } from "../config.ts";
import { ReviewError, validationError } from "../errors.ts";
import type { StructuredOutput } from "../output.ts";
import {
  INIT_SCOPES,
  installSkill,
  skillTarget,
  type InitRoots,
  type InitScope,
  type InstallReport,
  type SkillTarget,
} from "../skill-install.ts";
import { isSkillAgent, renderSkillFor, SKILL_AGENTS, type SkillAgent } from "../skill.ts";
import { hasFlag, lastValue, scanArgs } from "./args.ts";
import { HELP_START } from "./home.ts";

export interface InitArgs {
  /** Undefined is the point of the type: `init` with no agent has to name the
   * ids that exist rather than guess one — unless `--config` gave it other work. */
  agent: string | undefined;
  /** Undefined when the flag was absent, which is not the same as `global`:
   * `--scope` decides where a skill goes and nothing else, so naming one with
   * no agent is a flag that cannot apply. */
  scope: string | undefined;
  /** `--config`: leave a starter `.lightspeed.conf.json` behind. Enough on its
   * own — a config has one place to go, so nothing is being guessed. */
  config: boolean;
  dryRun: boolean;
}

export type InitInput = InitArgs & InitRoots;

interface ConfigReport {
  path: string;
  /** `exists` is a report, not a failure: the config is the user's file. */
  status: "written" | "exists";
}

/**
 * The step the setup instructions never had. A skill is scanned when the agent
 * starts, so the session that ran `init` is the one session that cannot see
 * what it wrote — which made a correct install look like nothing happened.
 */
export const HELP_RESTART_AGENT =
  "Restart your agent so it scans the new skill — in pi, `/reload` does it without" +
  " leaving the session; skills are read at startup, so a running session sees nothing";

const DRY_RUN_HELP = "Nothing was written: re-run without --dry-run to install it";

const CONFIG_KEPT_HELP =
  `${CONFIG_FILENAME} was already there and was left untouched —` +
  " check its `model` and `thinking` yourself";

const CONFIG_PLACEHOLDER_HELP =
  `Replace the \`model\` placeholder in ${CONFIG_FILENAME} with a real \`provider/model\`:` +
  " no review can run until it names one";

/**
 * The write side of `skill`. `skill` prints the document and trusts a human to
 * redirect it into the right file; nobody did, and the path they were told to
 * redirect it to was wrong for pi. This puts it where the named agent reads.
 */
export function runInit(input: InitInput): StructuredOutput {
  const agent = readAgent(input);
  const skill = agent === undefined ? undefined : installSkillFor(agent, input);
  const config = input.config ? installConfig(input.cwd, input.dryRun) : undefined;
  return initOutput({ skill, config, dryRun: input.dryRun });
}

function installSkillFor(agent: SkillAgent, input: InitInput): SkillOutcome {
  const scope = requireScope(input.scope ?? "global");
  const target = requireTarget(agent, scope, input);
  return { agent, scope, report: installSkill(target, renderSkillFor(agent), input.dryRun) };
}

export function parseInitArgs(args: string[]): InitArgs {
  const scanned = scanArgs(args, {
    value: ["--agent", "--scope"],
    boolean: ["--config", "--dry-run"],
    // Fail loud, as `skill` does: a swallowed flag would write a file somewhere
    // nobody asked for, with nothing on screen saying where or why.
    onUnknown: unknownInitFlag,
    onMissingValue: missingValue,
    // `--agent --dry-run` is an agent nobody named, not an agent called `--dry-run`.
    values: "bare",
  });
  const positional = scanned.positional[0];
  if (positional !== undefined) throw positionalAgent(positional);
  return {
    agent: lastValue(scanned, "--agent"),
    scope: lastValue(scanned, "--scope"),
    config: hasFlag(scanned, "--config"),
    dryRun: hasFlag(scanned, "--dry-run"),
  };
}

/**
 * Undefined is an answer only when `--config` gave the run something else to do.
 * Which of five files a skill belongs in has four wrong answers and no safe
 * default; where a config goes has neither, so demanding an agent to scaffold
 * one would be friction that buys nothing.
 */
function readAgent(input: InitInput): SkillAgent | undefined {
  const { agent } = input;
  if (agent === undefined) return withoutAgent(input);
  if (!isSkillAgent(agent)) throw unknownAgent(agent);
  return agent;
}

function withoutAgent(input: InitInput): undefined {
  if (!input.config) throw agentMissing();
  if (input.scope !== undefined) throw scopeWithoutAgent();
  return undefined;
}

function requireScope(scope: string): InitScope {
  const scopes: readonly string[] = INIT_SCOPES;
  if (!scopes.includes(scope)) throw unknownScope(scope);
  return scope as InitScope;
}

function requireTarget(agent: SkillAgent, scope: InitScope, roots: InitRoots): SkillTarget {
  const target = skillTarget(agent, scope, roots);
  if (target === undefined) throw noGlobalTarget(agent);
  return target;
}

/**
 * Refuses to overwrite: a config that exists holds a model somebody chose, and
 * a starter file would silently replace it with a placeholder. Reported and not
 * thrown — the skill next to it installed fine, and that is the command's job.
 */
function installConfig(cwd: string, dryRun: boolean): ConfigReport {
  const path = join(cwd, CONFIG_FILENAME);
  if (existsSync(path)) return { path, status: "exists" };
  if (!dryRun) writeFileSync(path, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`);
  return { path, status: "written" };
}

interface SkillOutcome {
  agent: SkillAgent;
  scope: InitScope;
  report: InstallReport;
}

interface InitOutcome {
  skill: SkillOutcome | undefined;
  config: ConfigReport | undefined;
  dryRun: boolean;
}

/**
 * Every path written is named, so the agent that ran this can say what changed
 * without going and looking. A run that installed no skill reports no `init`
 * block and no `skill` block at all: an agent and a scope it was never given
 * would be invented, and an empty one would still have to be read.
 */
function initOutput({ skill, config, dryRun }: InitOutcome): StructuredOutput {
  return {
    ...(skill === undefined
      ? {}
      : { init: { agent: skill.agent, scope: skill.scope }, skill: skill.report }),
    ...(config === undefined ? {} : { config }),
    ...(dryRun ? { dryRun } : {}),
    help: initHelp(skill !== undefined, dryRun, config),
  };
}

function initHelp(installed: boolean, dryRun: boolean, config: ConfigReport | undefined): string[] {
  return [
    ...(dryRun ? [DRY_RUN_HELP] : []),
    // Only where a skill was actually written: nothing is waiting on a restart
    // after a run that wrote a config and left every agent alone.
    ...(installed ? [HELP_RESTART_AGENT] : []),
    ...configHelp(config),
    HELP_START,
  ];
}

/** A starter config names no model, so the `start` in the line below it would
 * fail on the placeholder; one that was there already was left alone, and the
 * caller has to know the settings in force are not the ones init would write. */
function configHelp(config: ConfigReport | undefined): string[] {
  if (config === undefined) return [];
  return config.status === "exists" ? [CONFIG_KEPT_HELP] : [CONFIG_PLACEHOLDER_HELP];
}

/**
 * Mirrors `start`'s `intent_missing`: the one thing only the caller knows is
 * asked for by name and refused before a single path is touched, because every
 * agent reads a different file and a default would install into the wrong one.
 */
function agentMissing(): ReviewError {
  return new ReviewError({
    code: "agent_missing",
    message: "init needs --agent, or --config on its own: say which of the two to write",
    detail:
      "every agent reads its skill from a different file, so there is nothing safe" +
      ` to guess; supported: ${SKILL_AGENTS.join(", ")}.` +
      ` \`--config\` on its own writes ${CONFIG_FILENAME} and no skill`,
    suggestions: [
      "Run `lightspeed init --agent <id>` with one of the ids above",
      `Run \`lightspeed init --config\` to scaffold ${CONFIG_FILENAME} and nothing else`,
      "Run `lightspeed init --help` for the file each agent reads",
    ],
  });
}

/** Accepting it would be a flag that changes nothing, which is worse than a refusal. */
function scopeWithoutAgent(): ReviewError {
  return new ReviewError({
    code: "invalid_arguments",
    message: "--scope needs --agent: it decides where a skill goes and nothing else",
    detail:
      `${CONFIG_FILENAME} is always written in the directory init runs in,` +
      " so a scope with no agent would decide nothing",
    suggestions: [
      `Run \`lightspeed init --config\` to scaffold ${CONFIG_FILENAME} where you are`,
      "Run `lightspeed init --agent <id> --scope project --config` to write both",
    ],
  });
}

function unknownAgent(agent: string): ReviewError {
  return new ReviewError({
    code: "invalid_arguments",
    message: `\`${agent}\` is not an agent init can write for`,
    detail: `supported: ${SKILL_AGENTS.join(", ")}`,
    suggestions: [
      "Run `lightspeed init --agent <id>` with one of the ids above",
      "Run `lightspeed init --help` for the file each agent reads",
    ],
  });
}

function unknownScope(scope: string): ReviewError {
  return new ReviewError({
    code: "invalid_arguments",
    message: `\`${scope}\` is not a scope init can write to`,
    detail: `supported: ${INIT_SCOPES.join(", ")}`,
    suggestions: [
      "Run `lightspeed init --agent <id>` to install for the machine",
      "Run `lightspeed init --agent <id> --scope project` to install into this repository",
    ],
  });
}

function noGlobalTarget(agent: SkillAgent): ReviewError {
  return new ReviewError({
    code: "invalid_arguments",
    message: `${agent} has no machine-wide instructions file`,
    detail: `${agent} reads its instructions per repository, so there is no global file to write`,
    suggestions: [`Run \`lightspeed init --agent ${agent} --scope project\` from the repo root`],
  });
}

function unknownInitFlag(flag: string): Error {
  return validationError(`unknown flag ${flag}`, [
    "Known here: --agent, --scope, --config, --dry-run",
    "Run `lightspeed init --help` for what they do",
  ]);
}

function missingValue(flag: string): Error {
  return validationError(`${flag} needs a value`, [
    `--agent takes one of ${SKILL_AGENTS.join(", ")}`,
    `--scope takes one of ${INIT_SCOPES.join(", ")}`,
  ]);
}

function positionalAgent(token: string): ReviewError {
  return new ReviewError({
    code: "invalid_arguments",
    message: "init takes no positional arguments",
    detail: `agents are named with --agent: ${SKILL_AGENTS.join(", ")}`,
    suggestions: [`Run \`lightspeed init --agent ${token}\``],
  });
}
