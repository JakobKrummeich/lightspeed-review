import { createRequire } from "node:module";
import { homedir } from "node:os";
import { exitCodeForError, runAxiCli } from "axi-sdk-js";
import {
  HELP_END,
  HELP_POLL,
  HELP_START,
  homeOutput,
  sessionSummaries,
  type SessionSummary,
} from "./commands/home.ts";
import { parseApprovalsArgs, runApprovals } from "./commands/approvals.ts";
import { commandHelp, commandSummary } from "./commands/command-help.ts";
import { runEnd } from "./commands/end.ts";
import { runFeedback } from "./commands/feedback.ts";
import { parseInitArgs, runInit } from "./commands/init.ts";
import { authStateDir, runLogin } from "./commands/login.ts";
import { runLogout } from "./commands/logout.ts";
import { parsePollArgs, runPoll } from "./commands/poll.ts";
import { runServe } from "./commands/serve.ts";
import { parseSkillArgs, runSkill } from "./commands/skill.ts";
import { parseStartArgs, runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { loadConfig, loadLedgerConfig, type LightspeedConfig } from "./config.ts";
import { ReviewError, validationError } from "./errors.ts";
import type { StructuredOutput } from "./output.ts";
import { errorOutput, exitQuietlyWhenReaderCloses, renderToon } from "./output.ts";
import { LOGIN_PROVIDERS } from "./llm/pi-auth.ts";
import { findRepoRoot, repoRootOrNone } from "./repo.ts";
import { resolveSession, type ResolvedSession } from "./session-resolve.ts";
import { SessionStore } from "./session-store.ts";

// Single-sourced from package.json; resolves the same from `src/cli.ts` and `dist/cli.mjs`.
const require = createRequire(import.meta.url);
const { version, description } = require("../package.json") as {
  version: string;
  description: string;
};

/** Command name to handler; the one list the CLI answers, and the one both
 * top-level help and the unknown-command error are built from. */
const commands = {
  start: startCommand,
  poll: pollCommand,
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

/**
 * Every command is listed, `serve` and `login`/`logout` included: a help page
 * that hides a command the CLI still answers is how an agent burns a turn
 * guessing. Their own descriptions carry the caveat — `serve` says `start`
 * spawns it, `login` says an agent must never run it — so listing them warns
 * where hiding them would only puzzle. The workflow keeps its `help[]` lines
 * under the listing: three of eleven commands are the loop, and a flat list
 * cannot say which three.
 */
const topLevelHelp = `${renderToon({
  description,
  commands: Object.fromEntries(COMMAND_NAMES.map((name) => [name, commandSummary(name)])),
  help: [HELP_START, HELP_POLL, HELP_END],
})}\n`;

/** Everything a command needs before it can talk to a session or the server. */
function repoContext(): { repoRoot: string; config: LightspeedConfig } {
  const repoRoot = findRepoRoot(process.cwd());
  return { repoRoot, config: loadConfig(repoRoot) };
}

/** Which review the positional `<branch> [base]` arguments name. */
function resolveTarget(
  repoRoot: string,
  config: LightspeedConfig,
  branch: string | undefined,
  base: string | undefined,
): ResolvedSession {
  return resolveSession(new SessionStore(config.stateDir).list(), repoRoot, branch, base);
}

/** Extracts the diff, groups it and opens the review page. Safe to re-run. */
async function startCommand(args: string[]): Promise<StructuredOutput> {
  const { branch, base, open, model, reopen, intents } = parseStartArgs(args);
  if (branch === undefined) {
    throw new ReviewError({
      code: "invalid_arguments",
      message: "start needs the branch under review",
      suggestions: [HELP_START],
    });
  }
  // Checked before repo/config/git/model: nothing else is worth doing without an intent.
  if (intents.length === 0) {
    throw new ReviewError({
      code: "intent_missing",
      message: "start needs --intent: say what this branch is for",
      detail:
        "you opened this review, so you are the only party that knows why the branch exists;" +
        " repeat --intent once per reason and the reviewer reads them above the diff",
      suggestions: [
        HELP_START,
        `lightspeed start ${branch} ${base ?? "main"} --intent "<why this branch exists>"`,
      ],
    });
  }
  const { repoRoot, config } = repoContext();
  return await runStart({
    repoRoot,
    branch,
    base: base ?? "main",
    config: model === undefined ? config : { ...config, model },
    intents,
    open,
    reopen,
  });
}

/** Blocks in the foreground until the reviewer sends feedback. */
async function pollCommand(args: string[]): Promise<StructuredOutput> {
  const { branch, base, agentReply, full, declarations } = parsePollArgs(args);
  const { repoRoot, config } = repoContext();
  const target = resolveTarget(repoRoot, config, branch, base);
  return await runPoll({ repoRoot, ...target, port: config.port, agentReply, full, declarations });
}

/** Names the files behind the counts poll reports; nothing else prints them. */
function approvalsCommand(args: string[]): StructuredOutput {
  const { branch, base, full } = parseApprovalsArgs(args);
  const { repoRoot, config } = repoContext();
  const target = resolveTarget(repoRoot, config, branch, base);
  return runApprovals({ repoRoot, ...target, stateDir: config.stateDir, full });
}

/** Agent-initiated close of a review session. */
async function endCommand(args: string[]): Promise<StructuredOutput> {
  const { repoRoot, config } = repoContext();
  const target = resolveTarget(repoRoot, config, args[0], args[1]);
  return await runEnd({ repoRoot, ...target, port: config.port });
}

/** Runs the review server in the foreground; `start` spawns this detached. */
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

/** Shuts the background review server down. */
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

/** Human-run OAuth sign-in — the one interactive surface, and never an agent's. */
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

/**
 * Writes that same document where the named agent will actually read it. Home
 * and cwd are passed in rather than read inside, so the destinations a test
 * drives are temporary directories and never the developer's own agents.
 */
function initCommand(args: string[]): StructuredOutput {
  return runInit({ ...parseInitArgs(args), home: homedir(), cwd: process.cwd() });
}

/** Home view must always render: a repo without config just shows no sessions. */
function liveSessions(): SessionSummary[] {
  try {
    return sessionSummaries(new SessionStore(repoContext().config.stateDir).list());
  } catch {
    return [];
  }
}

/**
 * Exit 2 = "the command line was wrong". The SDK only knows its own VALIDATION_ERROR,
 * so these map alongside it rather than as generic failures an agent would retry.
 */
const ARGUMENT_ERROR_CODES = ["invalid_arguments", "intent_missing", "agent_missing"];

function exitCodeFor(error: unknown): number {
  if (error instanceof ReviewError && ARGUMENT_ERROR_CODES.includes(error.code)) return 2;
  return exitCodeForError(error);
}

/**
 * A guessed command name is an agent's most common first failure, and the SDK's
 * own version of it renders `error` as a string with no code. Routing it through
 * `errorOutput` keeps one error schema across the whole CLI, and the real
 * command list saves the round trip `--help` would cost. The SDK exits 2 here,
 * which is already this CLI's code for a command line it could not read.
 */
function unknownCommandOutput(command: string): string {
  const error = validationError(`Unknown command: ${command}`, [
    `Known commands: ${COMMAND_NAMES.join(", ")}`,
    "Run `lightspeed --help` for what each one does",
  ]);
  return `${renderToon(errorOutput(error))}\n`;
}

exitQuietlyWhenReaderCloses();
await runAxiCli({
  description,
  // TOON errors on stdout so an agent parses failures like results, not prose off stderr.
  formatError: (error) => ({
    output: `${renderToon(errorOutput(error))}\n`,
    exitCode: exitCodeFor(error),
  }),
  version,
  topLevelHelp,
  getCommandHelp: commandHelp,
  renderUnknownCommand: unknownCommandOutput,
  commands,
  home: () => homeOutput(liveSessions()),
});
