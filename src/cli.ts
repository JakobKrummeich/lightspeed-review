import { createRequire } from "node:module";
import { homedir } from "node:os";
import { exitCodeForError, runAxiCli } from "axi-sdk-js";
import {
  HELP_END,
  HELP_START,
  HELP_WAIT,
  TURN_RULE,
  homeOutput,
  type HomeInput,
} from "./commands/home.ts";
import { parseApprovalsArgs, runApprovals } from "./commands/approvals.ts";
import { parseAskArgs, runAsk } from "./commands/ask.ts";
import { commandHelp, commandSummary } from "./commands/command-help.ts";
import { runEnd } from "./commands/end.ts";
import { runFeedback } from "./commands/feedback.ts";
import { parseInitArgs, runInit } from "./commands/init.ts";
import { authStateDir, runLogin } from "./commands/login.ts";
import { runLogout } from "./commands/logout.ts";
import { parseSayArgs, runSay } from "./commands/say.ts";
import { runServe } from "./commands/serve.ts";
import { parseWaitArgs, runWait } from "./commands/wait.ts";
import { parseWorkArgs, runWork } from "./commands/work.ts";
import { parseSkillArgs, runSkill } from "./commands/skill.ts";
import { parseStartArgs, runStart } from "./commands/start.ts";
import { runStop } from "./commands/stop.ts";
import { defaultStateDir, loadConfig, loadLedgerConfig, type LightspeedConfig } from "./config.ts";
import { ReviewError, validationError } from "./errors.ts";
import type { StructuredOutput } from "./output.ts";
import { errorOutput, exitQuietlyWhenReaderCloses, renderToon } from "./output.ts";
import { LOGIN_PROVIDERS } from "./llm/pi-auth.ts";
import { findRepoRoot, repoRootOrNone } from "./repo.ts";
import { resolveSession, type ResolvedSession } from "./session-resolve.ts";
import { SessionStore, type SessionRecord } from "./session-store.ts";

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
  wait: waitCommand,
  ask: askCommand,
  say: sayCommand,
  work: workCommand,
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

/** The home view's one flag; documented here because it is the only place a
 * flag can appear before a command, and so the only place it can be missed. */
const HELP_ALL =
  "list live sessions from every repository, not just this one; bare `lightspeed`" +
  " shows the repository you are in";

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
  flags: { "--all": HELP_ALL },
  help: [TURN_RULE, HELP_START, HELP_WAIT, HELP_END],
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
  const { branch, base, open, model, reopen, wait, intents } = parseStartArgs(args);
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
    wait,
  });
}

/** The one blocking call: the turn comes to the agent when this returns. */
async function waitCommand(args: string[]): Promise<StructuredOutput> {
  const { branch, base, full } = parseWaitArgs(args);
  const { repoRoot, config } = repoContext();
  const target = resolveTarget(repoRoot, config, branch, base);
  return await runWait({ repoRoot, ...target, port: config.port, full });
}

/** Puts a question to the reviewer and blocks on their answer. */
async function askCommand(args: string[]): Promise<StructuredOutput> {
  const { message, branch, base } = parseAskArgs(args);
  const { repoRoot, config } = repoContext();
  const target = resolveTarget(repoRoot, config, branch, base);
  return await runAsk({ repoRoot, ...target, port: config.port, question: message });
}

/** Says something without blocking and without giving the turn up. */
async function sayCommand(args: string[]): Promise<StructuredOutput> {
  const parsed = parseSayArgs(args);
  const { repoRoot, config } = repoContext();
  const target = resolveTarget(repoRoot, config, parsed.branch, parsed.base);
  return await runSay({
    repoRoot,
    ...target,
    port: config.port,
    text: parsed.message,
    ...(parsed.for === undefined ? {} : { for: parsed.for }),
    files: parsed.files,
  });
}

/** Declares the plan the agent is about to go quiet over. */
async function workCommand(args: string[]): Promise<StructuredOutput> {
  const { message, branch, base } = parseWorkArgs(args);
  const { repoRoot, config } = repoContext();
  const target = resolveTarget(repoRoot, config, branch, base);
  return await runWork({ repoRoot, ...target, port: config.port, plan: message });
}

/** Names the files behind the counts `wait` reports; nothing else prints them. */
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

/**
 * Home view must always render, so nothing here throws — but what stopped a
 * review from running is the answer, not something to swallow. A bare catch
 * turned a missing config into `sessions: 0`, which is the one reading that is
 * both false and costs a turn: the sessions were on disk and the command it
 * then offered fails the same way.
 */
function homeInput(all: boolean): HomeInput {
  const repoRoot = repoRootOrNone(process.cwd());
  if (repoRoot === undefined) return { sessions: storedSessions(defaultStateDir()), all };
  try {
    const { stateDir } = loadConfig(repoRoot);
    return { repoRoot, sessions: storedSessions(stateDir), all };
  } catch (error) {
    // The store is a machine-wide directory a config only redirects, so an
    // unreadable one still knows where to look: the default.
    return {
      repoRoot,
      config: codeOf(error) === "config_missing" ? "missing" : "invalid",
      sessions: storedSessions(defaultStateDir()),
      all,
    };
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ReviewError ? error.code : undefined;
}

/** A corrupt session file must not take the whole view down with it. */
function storedSessions(stateDir: string): SessionRecord[] {
  try {
    return new SessionStore(stateDir).list();
  } catch {
    return [];
  }
}

/**
 * Exit 2 = "the command line was wrong". The SDK only knows its own VALIDATION_ERROR,
 * so these map alongside it rather than as generic failures an agent would retry.
 */
const ARGUMENT_ERROR_CODES = [
  "invalid_arguments",
  "intent_missing",
  "agent_missing",
  // A move made out of turn is a wrong command line like any other: the fixing
  // command is in the error's own `help[]`, and exit 2 says "read it, don't retry".
  "turn_not_yours",
  // Waiting while still holding the turn is the same mistake from the other end.
  "turn_still_yours",
];

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

/**
 * The SDK refuses a leading flag before it dispatches, so the one flag the home
 * view takes is read off argv here and the SDK is handed the bare invocation it
 * knows. Alone on the line, because there is no command for it to modify.
 */
const argv = withHelpAlias(process.argv.slice(2));
const allRepos = argv.length === 1 && argv[0] === "--all";

/**
 * `help` is the word an agent types before it has read anything, and the answer
 * used to be `Unknown command: help`: a turn spent discovering that this CLI
 * spells it `--help`. Translated into the flag rather than registered as a
 * command, so there is one help text and `help start` is `start --help`
 * exactly — including the unknown-command error a name that is not a command
 * still earns.
 */
function withHelpAlias(given: string[]): string[] {
  if (given[0] !== "help") return given;
  const [, name] = given;
  return name === undefined ? ["--help"] : [name, "--help"];
}

exitQuietlyWhenReaderCloses();
await runAxiCli({
  argv: allRepos ? [] : argv,
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
  home: () => homeOutput(homeInput(allRepos)),
});
