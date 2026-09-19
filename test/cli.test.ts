import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { git, newRepo } from "./helpers/git-repo.ts";
import { sessionKey } from "../src/paths.ts";
import { SessionStore } from "../src/session-store.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runCli(
  args: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd, env });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? 1 };
  }
}

/**
 * A server that holds the port and answers 404 to everything: the review server
 * as an agent meets it when the session it names was never opened there.
 */
async function servePlain404(): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "session_not_found", message: "no session" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => void server.close());
  return (server.address() as AddressInfo).port;
}

/**
 * A repository of its own, with its own `stateDir`: run from this checkout the
 * home view would list whatever reviews the developer has open.
 */
function emptyRepo(): string {
  const repoRoot = newRepo("lsr-cli-home-");
  writeFileSync(
    join(repoRoot, ".lightspeed.conf.json"),
    JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      thinking: "off",
      stateDir: join(repoRoot, "state"),
    }),
  );
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "config");
  return repoRoot;
}

test("bare invocation prints the content-first home view", async () => {
  const repoRoot = emptyRepo();
  const { stdout, code } = await runCli([], repoRoot);

  assert.equal(code, 0);
  assert.match(stdout, /^description: Semantic diff review with targeted agent feedback$/m);
  assert.match(stdout, new RegExp(`^repo: ${repoRoot}$`, "m"));
  assert.match(stdout, /^sessions: 0$/m);
  assert.match(stdout, /^message: no active review sessions$/m);
  assert.match(stdout, /^help\[1\]:/m);
});

/** A session belonging to some other repository, in the state directory the
 * repo under test reads. */
function storeSession(stateDir: string, repoRoot: string, branch: string): void {
  const at = "2025-01-01T00:00:00.000Z";
  new SessionStore(stateDir).save({
    key: sessionKey(repoRoot, branch, "main"),
    repoRoot,
    branch,
    base: "main",
    status: "open",
    turn: { holder: "reviewer", at },
    createdAt: at,
    updatedAt: at,
    groups: [],
    conversation: [],
    pending: [],
    approved: [],
    rounds: [{ index: 0, at, files: [], approvedAtEnd: [] }],
  });
}

/**
 * B1: the home view caught `config_missing` and reported `sessions: 0` with
 * `start` as the next step — false twice over, and one wasted turn for every
 * cold agent in every unconfigured repository.
 */
test("bare invocation in a repo with no config reports the config, not an empty review list", async () => {
  const repoRoot = newRepo("lsr-cli-noconf-");
  // No config names a state directory, so the view reads the default one —
  // which is where the sessions it used to report as absent actually were.
  const home = mkdtempSync(join(tmpdir(), "lsr-cli-home-dir-"));
  storeSession(join(home, ".lightspeed"), "/somewhere/else", "feat/tokens");

  const { stdout, code } = await runCli([], repoRoot, { ...process.env, HOME: home });

  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`^repo: ${repoRoot}$`, "m"));
  assert.match(stdout, /^config: missing$/m);
  assert.match(
    stdout,
    /^message: .*no config in this repo, so no review can run here; 1 session lives in another repo/m,
  );
  assert.match(stdout, /lightspeed init --config/);
});

/** S1: `--all` is the only flag that comes before a command, and the SDK
 * refuses a leading flag before it ever dispatches — so the CLI reads it
 * itself. Proving it here proves the plumbing, not just the renderer. */
test("--all lists other repositories' sessions, which the repo-scoped view names but omits", async () => {
  const repoRoot = emptyRepo();
  const stateDir = join(repoRoot, "state");
  storeSession(stateDir, "/somewhere/else", "feat/tokens");

  const scoped = await runCli([], repoRoot);
  const all = await runCli(["--all"], repoRoot);

  assert.equal(scoped.code, 0);
  assert.match(scoped.stdout, /^sessions: 0$/m);
  assert.match(scoped.stdout, /^elsewhere: 1 session in 1 other repo/m);
  assert.equal(all.code, 0, all.stdout);
  assert.match(all.stdout, /^sessions\[1\]\{repo,branch,base,turn,round,pending\}:$/m);
  assert.match(all.stdout, /^ {2}\/somewhere\/else,feat\/tokens,main,reviewer,1,0$/m);
});

/**
 * S7 through the store: `approvals` reads the session file itself, so a review
 * nobody opened must be named by what the agent typed, beside what is there.
 */
test("a command about a review nothing holds names the reviews that are held", async () => {
  const repoRoot = emptyRepo();
  storeSession(join(repoRoot, "state"), repoRoot, "feature/greeting");

  const { stdout, code } = await runCli(["approvals", "other/branch", "main"], repoRoot);

  assert.equal(code, 1);
  assert.match(stdout, /^ {2}code: session_not_found$/m);
  assert.match(
    stdout,
    new RegExp(`message: no review session for other/branch against main in ${repoRoot}`),
  );
  assert.match(stdout, /1 live session in this repo: feature\/greeting against main/);
  assert.match(stdout, /lightspeed start other\/branch main --intent/);
  assert.match(stdout, /lightspeed approvals feature\/greeting main/);
});

/**
 * The same failure off the wire: the server answers 404 for a key it does not
 * hold, and the agent must read the same two facts as in the store case.
 */
test("a session the server does not know is named the same way as one on disk", async () => {
  const repoRoot = emptyRepo();
  storeSession(join(repoRoot, "state"), repoRoot, "feature/greeting");
  const port = await servePlain404();
  writeFileSync(
    join(repoRoot, ".lightspeed.conf.json"),
    JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      thinking: "off",
      stateDir: join(repoRoot, "state"),
      port,
    }),
  );

  const { stdout, code } = await runCli(["wait", "other/branch", "main"], repoRoot);

  assert.equal(code, 1);
  assert.match(stdout, /^ {2}code: session_not_found$/m);
  assert.match(stdout, /message: no review session for other\/branch against main/);
  assert.match(stdout, /1 live session in this repo: feature\/greeting against main/);
  assert.match(stdout, /lightspeed wait feature\/greeting main/);
});

/**
 * B2: `approvals` reads a session file and nothing else, but the strict config
 * load gated it on a `model` it never uses — so a repo without a config could
 * not be asked what the reviewer had ticked.
 */
test("a command that needs no model answers in a repository with no config", async () => {
  const repoRoot = newRepo("lsr-cli-nomodel-");
  const home = mkdtempSync(join(tmpdir(), "lsr-cli-nomodel-home-"));
  storeSession(join(home, ".lightspeed"), repoRoot, "feature/greeting");

  const { stdout, code } = await runCli(["approvals", "feature/greeting", "main"], repoRoot, {
    ...process.env,
    HOME: home,
  });

  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /config_missing/);
  assert.match(stdout, /^ {2}branch: feature\/greeting$/m);
});

test("a failing command reports code, message and help as TOON on stdout, exit 1", async () => {
  const outsideAnyRepo = mkdtempSync(join(tmpdir(), "lsr-cli-"));

  const { stdout, code } = await runCli(
    ["start", "feature-auth", "--intent", "why"],
    outsideAnyRepo,
  );

  assert.equal(code, 1);
  assert.match(stdout, /^error:$/m);
  assert.match(stdout, /^ {2}code: git_repo_not_found$/m);
  assert.match(stdout, /^ {2}message: /m);
  assert.match(stdout, /^help\[\d+\]/m);
});

test("start without a branch says which argument is missing", async () => {
  const { stdout, code } = await runCli(["start"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: invalid_arguments$/m);
});

/** Nothing is worth doing before the review can say what the change is for. */
test("start without --intent fails before it looks for a repository at all", async () => {
  const outsideAnyRepo = mkdtempSync(join(tmpdir(), "lsr-cli-nointent-"));

  const { stdout, code } = await runCli(["start", "feature-auth"], outsideAnyRepo);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: intent_missing$/m);
  assert.match(stdout, /--intent/);
  assert.doesNotMatch(stdout, /git_repo_not_found/);
});

/**
 * Three mistakes, three recoveries, so three codes: an agent that branches on
 * `error.code` had to re-read the message to tell a misspelt command from a
 * misspelt flag from an argument it forgot, because all three answered
 * `VALIDATION_ERROR`.
 */
test("unknown flag before a command exits 2, under a code that names the mistake", async () => {
  const { stdout, code } = await runCli(["--bogus"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: unknown_flag$/m);
  assert.match(stdout, /unknown flag --bogus/);
  assert.match(stdout, /Flags come after the command/);
});

test("a forgotten argument is its own code, not the code an unknown flag has", async () => {
  const { stdout, code } = await runCli(["ask"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: argument_missing$/m);
  assert.match(stdout, /ask needs the question/);
});

/**
 * First contact for an agent that guessed a name: the failure it meets must parse
 * like every other one, `error.code` included, and name the commands that exist.
 */
test("an unknown command fails in the same error shape as everything else", async () => {
  const { stdout, code } = await runCli(["nonsense"]);

  assert.equal(code, 2);
  assert.match(stdout, /^error:$/m);
  assert.match(stdout, /^ {2}code: unknown_command$/m);
  assert.match(stdout, /^ {2}message: "?Unknown command: nonsense"?$/m);
  assert.match(stdout, /^help\[\d+\]/m);
  assert.match(stdout, /start, wait, ask, say, work, approvals/);
});

test("--help lists every command the CLI answers", async () => {
  const { stdout, code } = await runCli(["--help"]);

  assert.equal(code, 0);
  for (const command of [
    "start",
    "wait",
    "ask",
    "say",
    "work",
    "approvals",
    "end",
    "serve",
    "stop",
    "feedback",
    "login",
    "logout",
    "init",
    "skill",
  ]) {
    assert.match(stdout, new RegExp(`^ {2}"?${command}"?: `, "m"), command);
  }
  // The rule leads, then the workflow: start, wait, end in order.
  assert.match(stdout, /^help\[4\]/m);
  assert.match(stdout, /Queue always\. End always\. Send only on your turn\./);
});

/**
 * `help` is what an agent types before it has read anything, and the answer to
 * it used to be `Unknown command: help` — a turn spent learning the flag form
 * of a word the CLI already understood.
 */
test("`help` is a word the CLI answers, not a command it does not have", async () => {
  const { stdout, code } = await runCli(["help"]);

  assert.equal(code, 0);
  assert.match(stdout, /^commands:$/m);
  assert.doesNotMatch(stdout, /error:/);
});

test("`help <command>` describes that command, the same as `<command> --help`", async () => {
  const { stdout, code } = await runCli(["help", "start"]);

  assert.equal(code, 0);
  assert.match(stdout, /^command: start$/m);
  assert.doesNotMatch(stdout, /error:/);
});

/** A word that is not a command is not made one by `help` in front of it. */
test("`help nonsense` fails as the unknown command it names", async () => {
  const { stdout, code } = await runCli(["help", "nonsense"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}message: "?Unknown command: nonsense"?$/m);
});

test("a subcommand's --help describes it instead of running it", async () => {
  const { stdout, code } = await runCli(["start", "--help"]);

  assert.equal(code, 0);
  assert.match(stdout, /^command: start$/m);
  assert.match(stdout, /--intent/);
  assert.match(stdout, /--no-open/);
  assert.doesNotMatch(stdout, /error:/);
});

test("feedback runs against the repo's own state dir and reports a definitive empty ledger", async () => {
  const { stdout, code } = await runCli(["feedback"], emptyRepo());

  assert.equal(code, 0);
  assert.match(stdout, /^ {2}status: on$/m);
  assert.match(stdout, /^items: 0$/m);
  assert.match(stdout, /^help\[\d+\]/m);
});

test("feedback reads a ledger outside any repository, with no model configured", async () => {
  const nowhere = mkdtempSync(join(tmpdir(), "lsr-cli-nowhere-"));
  writeFileSync(
    join(nowhere, ".lightspeed.conf.json"),
    JSON.stringify({ stateDir: join(nowhere, "state") }),
  );

  const { stdout, code } = await runCli(["feedback"], nowhere);

  assert.equal(code, 0);
  assert.match(stdout, /^items: 0$/m);
  assert.match(stdout, new RegExp(`path: ${nowhere}/state/feedback$`, "m"));
});

/** No config file at all is the mining agent's normal case: the defaults describe it. */
test("feedback with no config file reads the default ledger", async () => {
  const { stdout, code } = await runCli(["feedback"], mkdtempSync(join(tmpdir(), "lsr-cli-bare-")));

  assert.equal(code, 0);
  assert.match(stdout, /^ {2}path: .*\.lightspeed\/feedback$/m);
  assert.match(stdout, /^ {2}status: on$/m);
});

test("feedback --repo . outside a repository explains that there is none", async () => {
  const nowhere = mkdtempSync(join(tmpdir(), "lsr-cli-nowhere-"));

  const { stdout, code } = await runCli(["feedback", "list", "--repo", "."], nowhere);

  assert.equal(code, 1);
  assert.match(stdout, /code: git_repo_not_found/);
});

/** A mistyped flag used to be read as a branch name and reported as a bad git ref. */
test("start rejects an unknown flag instead of running with it", async () => {
  const { stdout, code } = await runCli(["start", "feature", "main", "--no-opne", "--intent", "x"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: unknown_flag$/m);
  assert.match(stdout, /unknown flag --no-opne/);
  assert.doesNotMatch(stdout, /git_ref_not_found/);
});

test("feedback rejects an unknown flag with exit 2", async () => {
  const { stdout, code } = await runCli(["feedback", "list", "--bogus"], emptyRepo());

  assert.equal(code, 2);
  assert.match(stdout, /code: unknown_flag/);
});

test("a missing or unparseable argument exits 2 like an unknown flag does", async () => {
  const repo = emptyRepo();

  const missingId = await runCli(["feedback", "show"], repo);
  const badSince = await runCli(["feedback", "list", "--since", "yesterday"], repo);

  assert.equal(missingId.code, 2);
  assert.equal(badSince.code, 2);
  assert.match(missingId.stdout, /code: invalid_arguments/);
  assert.match(badSince.stdout, /code: invalid_arguments/);
});

test("every command answers --help", async () => {
  for (const command of [
    "start",
    "wait",
    "ask",
    "say",
    "work",
    "end",
    "serve",
    "stop",
    "feedback",
  ]) {
    const { stdout, code } = await runCli([command, "--help"]);

    assert.equal(code, 0, command);
    assert.match(stdout, new RegExp(`^command: ${command}$`, "m"));
  }
});

/** Nothing is worth writing before the command says whose file it is writing. */
test("init without --agent names the agents instead of guessing one", async () => {
  const { stdout, code } = await runCli(["init"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: agent_missing$/m);
  assert.match(stdout, /pi, claude-code, codex, opencode, vscode/);
});

/**
 * The one end-to-end check of the destination, run against a home directory of
 * its own: a real one would rewrite the skill of whoever runs the suite.
 */
test("init --dry-run names the file pi scans and leaves the disk alone", async () => {
  const home = mkdtempSync(join(tmpdir(), "lsr-cli-init-"));

  const { stdout, code } = await runCli(["init", "--agent", "pi", "--dry-run"], undefined, {
    ...process.env,
    HOME: home,
  });

  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`path: ${home}/\\.pi/agent/skills/lightspeed/SKILL\\.md$`, "m"));
  assert.match(stdout, /^dryRun: true$/m);
  assert.deepEqual(readdirSync(home), []);
});

/** A config has one place to go, so scaffolding one asks for no agent. */
test("init --config on its own writes a config and no skill", async () => {
  const home = mkdtempSync(join(tmpdir(), "lsr-cli-cfg-home-"));
  const repo = mkdtempSync(join(tmpdir(), "lsr-cli-cfg-"));

  const { stdout, code } = await runCli(["init", "--config"], repo, {
    ...process.env,
    HOME: home,
  });

  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`path: ${repo}/\\.lightspeed\\.conf\\.json$`, "m"));
  assert.doesNotMatch(stdout, /^skill:$/m);
  assert.doesNotMatch(stdout, /[Rr]estart/);
  assert.deepEqual(readdirSync(home), []);
});

test("--version prints the package version", async () => {
  const { stdout, code } = await runCli(["--version"]);

  assert.equal(code, 0);
  assert.match(stdout, /^\d+\.\d+\.\d+$/m);
});
