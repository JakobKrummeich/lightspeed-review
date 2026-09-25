import { homedir } from "node:os";
import { runAxiCli } from "axi-sdk-js";
import { CLI_DESCRIPTION, CLI_VERSION } from "./version.ts";
import { homeOutput } from "./commands/home.ts";
import { homeInput } from "./commands/home-input.ts";
import { parseApprovalsArgs, runApprovals } from "./commands/approvals.ts";
import { commandHelp, commandSummary } from "./commands/command-help.ts";
import { runEnd } from "./commands/end.ts";
import { runFeedback } from "./commands/feedback.ts";
import { parseInitArgs, runInit } from "./commands/init.ts";
import { authStateDir, runLogin } from "./commands/login.ts";
import { runLogout } from "./commands/logout.ts";
import { runServe } from "./commands/serve.ts";
import { parseWorkArgs, runWork } from "./commands/work.ts";
import { parseSkillArgs, runSkill } from "./commands/skill.ts";
import { parseOpenArgs, runOpen } from "./commands/open.ts";
import { parsePublishArgs, runPublish } from "./commands/publish.ts";
import { parseReplyArgs, runReply } from "./commands/reply.ts";
import { removedVerb, REMOVED_VERBS } from "./commands/removed-verbs.ts";
import { runStop } from "./commands/stop.ts";
import {
  loadConfig,
  loadLedgerConfig,
  loadServiceConfig,
  type LightspeedConfig,
  type ServiceConfig,
} from "./config.ts";
import { ReviewError, exitCodeFor, invocationError } from "./errors.ts";
import type { StructuredOutput } from "./output.ts";
import { errorOutput, exitQuietlyWhenReaderCloses, renderToon } from "./output.ts";
import { LOGIN_PROVIDERS } from "./llm/pi-auth.ts";
import { findRepoRoot, repoRootOrNone } from "./repo.ts";
import { missingSession, resolveSession, type ResolvedSession } from "./session-resolve.ts";
import { SessionStore } from "./session-store.ts";
import { refreshSkills, skillNoticeOutput, type StaleSkill } from "./skill-freshness.ts";
import { HELP_END, HELP_OPEN, TURN_RULES } from "./turn-help.ts";

const version = CLI_VERSION;
const description = CLI_DESCRIPTION;

type Answer = StructuredOutput | string;

/** The one list: top-level help and the unknown-command error are both built from it. */
const commands: Record<string, (args: string[]) => Answer | Promise<Answer>> = {
  open: openCommand,
  reply: replyCommand,
  work: workCommand,
  publish: publishCommand,
  approvals: approvalsCommand,
  end: endCommand,
  serve: serveCommand,
  stop: stopCommand,
  feedback: feedbackCommand,
  login: loginCommand,
  logout: logoutCommand,
  init: initCommand,
  skill: skillCommand,
};

const COMMAND_NAMES = Object.keys(commands);

const HELP_ALL =
  "list live sessions from every repository, not just this one; bare `lightspeed`" +
  " shows the repository you are in";

/**
 * Every command is listed, `serve` and `login`/`logout` included: a help page
 * that hides a command the CLI still answers is how an agent burns a turn
 * guessing, and their own descriptions carry the caveat. The `help[]` lines
 * under the listing name the loop: three of eleven commands are it, and a flat
 * list cannot say which three.
 */
function topLevelHelp(notice: StructuredOutput): string {
  return `${renderToon({
    description,
    commands: Object.fromEntries(COMMAND_NAMES.map((name) => [name, commandSummary(name)])),
    flags: { "--all": HELP_ALL },
    help: [...TURN_RULES, HELP_OPEN, HELP_END],
    ...notice,
  })}\n`;
}

/**
 * `model` and `thinking` are read only by the one command that sends a diff to
 * a model: gating `reply` or `end` on a model they never call made a missing
 * config refuse the review loop itself.
 */
function repoContext(): { repoRoot: string; config: ServiceConfig } {
  const repoRoot = findRepoRoot(process.cwd());
  return { repoRoot, config: loadServiceConfig(repoRoot) };
}

function groupingContext(): { repoRoot: string; config: LightspeedConfig } {
  const repoRoot = findRepoRoot(process.cwd());
  return { repoRoot, config: loadConfig(repoRoot) };
}

interface SessionContext extends ResolvedSession {
  repoRoot: string;
  config: ServiceConfig;
}

/**
 * The `session_not_found` catch lives here because this is the only layer that
 * has both halves: the store knows what is open in this repository, and the
 * dispatch knows which command asked. Below it, a 404 off the wire and a
 * missing file on disk would each have to invent the same sentence.
 */
async function onSession<T>(
  verb: string,
  branch: string | undefined,
  base: string | undefined,
  run: (context: SessionContext) => T | Promise<T>,
): Promise<T> {
  const { repoRoot, config } = repoContext();
  const sessions = new SessionStore(config.stateDir).list();
  const target = resolveSession(sessions, repoRoot, branch, base);
  try {
    return await run({ repoRoot, config, ...target });
  } catch (error) {
    if (!(error instanceof ReviewError) || error.code !== "session_not_found") throw error;
    throw missingSession({ repoRoot, ...target, verb, sessions });
  }
}

/**
 * The branch may be left out only to re-attach: with one live session in this
 * repository, that is the one. A fresh open names its branch.
 */
async function openCommand(args: string[]): Promise<StructuredOutput> {
  const { branch, base, open, model, reopen, intents } = parseOpenArgs(args);
  const { repoRoot, config } = groupingContext();
  const target = resolveSession(new SessionStore(config.stateDir).list(), repoRoot, branch, base);
  return await runOpen({
    repoRoot,
    ...target,
    config: model === undefined ? config : { ...config, model },
    intents,
    open,
    reopen,
  });
}

async function replyCommand(args: string[]): Promise<StructuredOutput> {
  const { notes, branch, base } = parseReplyArgs(args);
  return await onSession("reply", branch, base, ({ config, ...target }) =>
    runReply({ ...target, port: config.port, notes }),
  );
}

async function publishCommand(args: string[]): Promise<StructuredOutput> {
  const { branch, base, model, intents, notes } = parsePublishArgs(args);
  const { repoRoot, config } = groupingContext();
  const sessions = new SessionStore(config.stateDir).list();
  const target = resolveSession(sessions, repoRoot, branch, base);
  return await runPublish({
    repoRoot,
    ...target,
    config: model === undefined ? config : { ...config, model },
    intents,
    notes,
  });
}

async function workCommand(args: string[]): Promise<StructuredOutput> {
  const { message, branch, base } = parseWorkArgs(args);
  return await onSession("work", branch, base, ({ config, ...target }) =>
    runWork({ ...target, port: config.port, plan: message }),
  );
}

async function approvalsCommand(args: string[]): Promise<StructuredOutput> {
  const { branch, base, full } = parseApprovalsArgs(args);
  return await onSession("approvals", branch, base, ({ config, ...target }) =>
    runApprovals({ ...target, stateDir: config.stateDir, full }),
  );
}

async function endCommand(args: string[]): Promise<StructuredOutput> {
  return await onSession("end", args[0], args[1], ({ config, ...target }) =>
    runEnd({ ...target, port: config.port }),
  );
}

async function serveCommand(): Promise<StructuredOutput> {
  const { config } = repoContext();
  return await runServe({
    stateDir: config.stateDir,
    port: config.port,
    feedbackLog: config.feedbackLog,
  });
}

/**
 * Ledger is global across repos, so this is the one command that runs without a
 * repository or config file; a config that exists is still read and validated.
 */
function feedbackCommand(args: string[]): StructuredOutput | string {
  const repoRoot = repoRootOrNone(process.cwd());
  const config = loadLedgerConfig(repoRoot ?? process.cwd());
  return runFeedback({
    args,
    ...(repoRoot === undefined ? {} : { repoRoot }),
    stateDir: config.stateDir,
    feedbackLog: config.feedbackLog,
  });
}

async function stopCommand(): Promise<StructuredOutput> {
  const { config } = repoContext();
  return await runStop({ port: config.port });
}

function requireProvider(args: string[], command: string): string {
  const provider = args[0];
  if (provider === undefined) {
    throw new ReviewError({
      code: "invalid_arguments",
      message: `${command} needs a provider id`,
      suggestions: [`Run \`lightspeed ${command} <provider>\`, e.g. ${LOGIN_PROVIDERS.join(", ")}`],
    });
  }
  return provider;
}

async function loginCommand(args: string[]): Promise<StructuredOutput> {
  const provider = requireProvider(args, "login");
  return await runLogin({ provider, stateDir: authStateDir(process.cwd()) });
}

async function logoutCommand(args: string[]): Promise<StructuredOutput> {
  const provider = requireProvider(args, "logout");
  return await runLogout({ provider, stateDir: authStateDir(process.cwd()) });
}

/**
 * Raw markdown, not TOON: the output is redirected into the file a coding agent
 * reads. The CLI terminates the last line itself, hence the trim.
 */
function skillCommand(args: string[]): string {
  return runSkill(parseSkillArgs(args)).trimEnd();
}

function initCommand(args: string[]): StructuredOutput {
  return runInit({ ...parseInitArgs(args), home: homedir(), cwd: process.cwd() });
}

/**
 * The SDK's own version renders `error` as a string with no code; routing it
 * through `errorOutput` keeps one error schema across the whole CLI, and the
 * real command list saves the round trip `--help` would cost. The SDK exits 2
 * here, which is already this CLI's code for a command line it could not read.
 */
function unknownCommandOutput(command: string): string {
  const error = invocationError("unknown_command", `Unknown command: ${command}`, [
    `Known commands: ${COMMAND_NAMES.join(", ")}`,
    "Run `lightspeed --help` for what each one does",
  ]);
  return renderFailure(error);
}

/**
 * The SDK refuses a leading flag before it dispatches, so the one flag the home
 * view takes is read off argv here and the SDK is handed the bare invocation it
 * knows. Alone on the line, because there is no command for it to modify.
 */
const argv = withHelpAlias(process.argv.slice(2));
const allRepos = argv.length === 1 && argv[0] === "--all";

/**
 * Translated into the flag rather than registered as a command, so there is
 * one help text and `help start` is `start --help` exactly — including the
 * unknown-command error a name that is not a command still earns.
 */
function withHelpAlias(given: string[]): string[] {
  if (given[0] !== "help") return given;
  const [, name] = given;
  return name === undefined ? ["--help"] : [name, "--help"];
}

/**
 * The SDK refuses a flag before the command in prose of its own, under its own
 * code; answered here instead, so `lightspeed --bogus` parses like every other
 * failure.
 */
function leadingFlagProblem(given: string[]): ReviewError | undefined {
  const [flag] = given;
  if (flag === undefined || !flag.startsWith("-")) return undefined;
  if (given.length === 1 && ["--all", "--help", "--version", "-v", "-V"].includes(flag)) {
    return undefined;
  }
  return invocationError(
    "unknown_flag",
    LEADING_FLAGS.includes(flag)
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

/**
 * Worked out once, before the command runs, and carried by every TOON answer
 * this process prints — failures most of all, since the verb a stale skill
 * teaches is the one that fails. `init` is left out: it is the explicit
 * install, and its `--dry-run` promises to write nothing at all.
 */
const skillNotice = argv[0] === "init" ? {} : skillNoticeOutput(staleSkills());

/** Nothing about a skill is worth failing the command the agent came for. */
function staleSkills(): StaleSkill[] {
  try {
    return refreshSkills({ home: homedir(), cwd: process.cwd() });
  } catch {
    return [];
  }
}

/** A string answer is a document on its way into a file (`skill`, a feedback
 * export), where a TOON notice would be a stray line in someone's file. */
function withSkillNotice(output: Answer): Answer {
  return typeof output === "string" ? output : { ...output, ...skillNotice };
}

/** Answered, not unknown: an agent on a 2.x skill is told where the verb went. */
function removedCommands(): Record<string, () => never> {
  return Object.fromEntries(REMOVED_VERBS.map((verb) => [verb, () => removedVerb(verb)]));
}

function renderFailure(error: unknown): string {
  return `${renderToon({ ...errorOutput(error), ...skillNotice })}\n`;
}

const noticedCommands = Object.fromEntries(
  Object.entries({ ...commands, ...removedCommands() }).map(([name, run]) => [
    name,
    async (args: string[]) => withSkillNotice(await run(args)),
  ]),
);

exitQuietlyWhenReaderCloses();
const leadingProblem = leadingFlagProblem(argv);
if (leadingProblem !== undefined) {
  process.stdout.write(renderFailure(leadingProblem));
  process.exitCode = 2;
} else {
  await runAxiCli({
    argv: allRepos ? [] : argv,
    description,
    // TOON errors on stdout so an agent parses failures like results, not prose off stderr.
    formatError: (error) => ({
      output: renderFailure(error),
      exitCode: exitCodeFor(error),
    }),
    version,
    topLevelHelp: topLevelHelp(skillNotice),
    getCommandHelp: (command) => commandHelp(command, skillNotice),
    renderUnknownCommand: unknownCommandOutput,
    commands: noticedCommands,
    home: async () => withSkillNotice(homeOutput(await homeInput(allRepos))),
  });
}
