import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git, newRepo } from "./helpers/git-repo.ts";

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
  const { stdout, code } = await runCli([], emptyRepo());

  assert.equal(code, 0);
  assert.match(stdout, /^description: Semantic diff review with targeted agent feedback$/m);
  assert.match(stdout, /^sessions: 0$/m);
  assert.match(stdout, /^message: no active review sessions$/m);
  assert.match(stdout, /^help\[1\]:/m);
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

test("unknown flag before a command exits 2", async () => {
  const { stdout, code } = await runCli(["--bogus"]);

  assert.equal(code, 2);
  assert.match(stdout, /code: VALIDATION_ERROR/);
});

/**
 * First contact for an agent that guessed a name: the failure it meets must parse
 * like every other one, `error.code` included, and name the commands that exist.
 */
test("an unknown command fails in the same error shape as everything else", async () => {
  const { stdout, code } = await runCli(["nonsense"]);

  assert.equal(code, 2);
  assert.match(stdout, /^error:$/m);
  assert.match(stdout, /^ {2}code: VALIDATION_ERROR$/m);
  assert.match(stdout, /^ {2}message: "?Unknown command: nonsense"?$/m);
  assert.match(stdout, /^help\[\d+\]/m);
  assert.match(stdout, /start, poll, approvals/);
});

test("--help lists every command the CLI answers", async () => {
  const { stdout, code } = await runCli(["--help"]);

  assert.equal(code, 0);
  for (const command of [
    "start",
    "poll",
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
  // The workflow stays called out under the listing: start, poll, end in order.
  assert.match(stdout, /^help\[3\]/m);
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
  assert.match(stdout, /^ {2}code: VALIDATION_ERROR$/m);
  assert.match(stdout, /unknown flag --no-opne/);
  assert.doesNotMatch(stdout, /git_ref_not_found/);
});

test("feedback rejects an unknown flag with exit 2", async () => {
  const { stdout, code } = await runCli(["feedback", "list", "--bogus"], emptyRepo());

  assert.equal(code, 2);
  assert.match(stdout, /code: VALIDATION_ERROR/);
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
  for (const command of ["start", "poll", "end", "serve", "stop", "feedback"]) {
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
