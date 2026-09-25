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

/**
 * Every command checks the skills under HOME and may rewrite one, so no run of
 * the suite may point it at the home of the developer running it.
 */
const isolatedHome = mkdtempSync(join(tmpdir(), "lsr-cli-isolated-home-"));

async function runCli(
  args: string[],
  cwd?: string,
  env: NodeJS.ProcessEnv = { ...process.env, HOME: isolatedHome },
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
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
 * A server that takes the connection and never answers: a review server hung
 * mid-request, the case a presence check must not wait out.
 */
async function serveSilence(): Promise<number> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return (server.address() as AddressInfo).port;
}

/**
 * Bare `lightspeed` asks the server whether a wait is parked. A server that
 * never answers is nobody listening, and home answers at once rather than hang.
 */
test("a presence check the server never answers reads as nobody listening, answered at once", async () => {
  const repoRoot = emptyRepo();
  const port = await serveSilence();
  writeFileSync(
    join(repoRoot, ".lightspeed.conf.json"),
    JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      thinking: "off",
      stateDir: join(repoRoot, "state"),
      port,
    }),
  );
  storeSession(join(repoRoot, "state"), repoRoot, "feature/greeting");
  const started = Date.now();

  const { stdout, code } = await runCli([], repoRoot);

  assert.equal(code, 0);
  assert.match(stdout, /^ {2}listen: /m);
  assert.match(stdout, /lightspeed open feature\/greeting main/);
  assert.doesNotMatch(stdout, /already waiting/);
  assert.ok(Date.now() - started < 5_000, "home did not wait out a hung server");
});

/**
 * Regression: the home view caught `config_missing` and reported `sessions: 0`
 * with `start` as the next step — false twice over.
 */
test("bare invocation in a repo with no config reports the config, not an empty review list", async () => {
  const repoRoot = newRepo("lsr-cli-noconf-");
  // No config names a state directory, so the view reads the default one.
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

/** `--all` is the only flag that comes before a command, and the SDK refuses a
 * leading flag before it ever dispatches — so the CLI reads it itself. Proving
 * it here proves the plumbing, not just the renderer. */
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

/** Through the store: `approvals` reads the session file itself. */
test("a command about a review nothing holds names the reviews that are held", async () => {
  const repoRoot = emptyRepo();
  storeSession(join(repoRoot, "state"), repoRoot, "feature/greeting");

  const { stdout, code } = await runCli(["approvals", "other/branch", "main"], repoRoot);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: session_not_found$/m);
  assert.match(
    stdout,
    new RegExp(`message: no review session for other/branch against main in ${repoRoot}`),
  );
  assert.match(stdout, /1 live session in this repo: feature\/greeting against main/);
  assert.match(stdout, /lightspeed open other\/branch main --intent/);
  assert.match(stdout, /lightspeed approvals feature\/greeting main/);
});

/** The same failure off the wire: the server answers 404 for a key it does not hold. */
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

  git(repoRoot, "branch", "other/branch");

  const { stdout, code } = await runCli(["work", "the plan", "other/branch", "main"], repoRoot);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: session_not_found$/m);
  assert.match(stdout, /message: no review session for other\/branch against main/);
  assert.match(stdout, /1 live session in this repo: feature\/greeting against main/);
  // The way out keeps the argument the verb needs, so it runs as printed.
  assert.match(stdout, /lightspeed work '<plan>' feature\/greeting main/);
});

/**
 * `reply --to main fixed it`: the shell split the text, and its last word reads
 * as a branch. No such branch and a live review here means the words were text.
 */
test("a word after an unquoted --to text that is no branch is named as text to quote", async () => {
  const repoRoot = emptyRepo();
  storeSession(join(repoRoot, "state"), repoRoot, "feature/greeting");

  const { stdout, code } = await runCli(["reply", "--to", "main", "fixed", "it"], repoRoot);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: invalid_arguments$/m);
  assert.match(stdout, /message: 'it' is not a branch — quote the whole text after --to$/m);
  assert.match(stdout, /lightspeed reply --to <id> '<answer>' feature\/greeting main/);
});

test("a word after an unquoted plan that is no branch is named as part of the plan", async () => {
  const repoRoot = emptyRepo();
  storeSession(join(repoRoot, "state"), repoRoot, "feature/greeting");

  const { stdout, code } = await runCli(["work", "split", "the", "handler"], repoRoot);

  assert.equal(code, 2);
  assert.match(stdout, /message: 'the' is not a branch — quote the whole plan$/m);
  assert.match(stdout, /lightspeed work '<plan>' feature\/greeting main/);
});

test("a publish whose --to text spilled into the branch is refused before any git work", async () => {
  const repoRoot = emptyRepo();
  storeSession(join(repoRoot, "state"), repoRoot, "feature/greeting");

  const { stdout, code } = await runCli(
    ["publish", "--intent", "why", "--to", "main", "done:", "signed"],
    repoRoot,
  );

  assert.equal(code, 2);
  assert.match(stdout, /message: 'signed' is not a branch — quote the whole text after --to$/m);
});

/** Regression: the strict config load gated `approvals` on a `model` it never uses. */
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

/**
 * An agent captures `2>&1`, so anything git says on its own behalf lands in
 * front of our TOON and breaks the parse.
 */
test("a git failure says nothing on stderr that stdout has not already said", async () => {
  const repoRoot = emptyRepo();

  const { stdout, stderr, code } = await runCli(
    ["open", "no/such/branch", "main", "--intent", "why", "--no-open"],
    repoRoot,
  );

  assert.equal(code, 1);
  assert.equal(stderr, "");
  assert.match(stdout, /^ {2}code: git_ref_not_found$/m);
  assert.match(stdout, /git rev-parse no\/such\/branch/);
});

test("a failing command reports code, message and help as TOON on stdout, exit 1", async () => {
  const outsideAnyRepo = mkdtempSync(join(tmpdir(), "lsr-cli-"));

  const { stdout, code } = await runCli(
    ["open", "feature-auth", "--intent", "why"],
    outsideAnyRepo,
  );

  assert.equal(code, 1);
  assert.match(stdout, /^error:$/m);
  assert.match(stdout, /^ {2}code: git_repo_not_found$/m);
  assert.match(stdout, /^ {2}message: /m);
  assert.match(stdout, /^help\[\d+\]/m);
});

/** Re-attaching may leave the branch out; with no session there is nothing to re-attach to. */
test("open without a branch and no live review names the branch it needs", async () => {
  const { stdout, code } = await runCli(["open"], emptyRepo());

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: session_not_found$/m);
  assert.match(stdout, /lightspeed open <branch> \[base\] --intent/);
});

test("a fresh open without --intent fails before any git or model work", async () => {
  const { stdout, code } = await runCli(["open", "no/such/branch", "--no-open"], emptyRepo());

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: intent_missing$/m);
  assert.doesNotMatch(stdout, /git_ref_not_found/);
});

/** Section 11: a stale skill's verb is answered with where the next step is. */
test("a removed verb exits 2 and points at bare lightspeed", async () => {
  for (const verb of ["wait", "ask", "say", "start"]) {
    const { stdout, code } = await runCli([verb, "feature-auth"]);

    assert.equal(code, 2, verb);
    assert.match(stdout, /^ {2}code: removed_verb$/m);
    assert.match(
      stdout,
      new RegExp(`'${verb}' was removed in 3\\.0, run lightspeed for your next step`),
    );
    assert.match(stdout, /Run `lightspeed` \(no arguments\)/);
  }
});

/**
 * Three codes, not one `VALIDATION_ERROR`: an agent that branches on `error.code`
 * should not have to re-read the message to tell a misspelt command from a
 * misspelt flag from an argument it forgot.
 */
test("unknown flag before a command exits 2, under a code that names the mistake", async () => {
  const { stdout, code } = await runCli(["--bogus"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: unknown_flag$/m);
  assert.match(stdout, /unknown flag --bogus/);
  assert.match(stdout, /Flags come after the command/);
});

test("a forgotten argument is its own code, not the code an unknown flag has", async () => {
  const { stdout, code } = await runCli(["reply", "feature-auth"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: argument_missing$/m);
  assert.match(stdout, /reply needs at least one --to/);
});

test("an unknown command fails in the same error shape as everything else", async () => {
  const { stdout, code } = await runCli(["nonsense"]);

  assert.equal(code, 2);
  assert.match(stdout, /^error:$/m);
  assert.match(stdout, /^ {2}code: unknown_command$/m);
  assert.match(stdout, /^ {2}message: "?Unknown command: nonsense"?$/m);
  assert.match(stdout, /^help\[\d+\]/m);
  assert.match(stdout, /open, reply, work, publish, approvals/);
});

test("--help lists every command the CLI answers", async () => {
  const { stdout, code } = await runCli(["--help"]);

  assert.equal(code, 0);
  for (const command of [
    "open",
    "reply",
    "work",
    "publish",
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
  // The turn rules lead, then open and end.
  assert.match(stdout, /^help\[5\]/m);
  assert.match(stdout, /Discussion strictly alternates/);
  for (const gone of ["wait", "ask", "say", "start"]) {
    assert.doesNotMatch(stdout, new RegExp(`^ {2}"?${gone}"?: `, "m"), gone);
  }
});

/** `help` is what an agent types before it has read anything. */
test("`help` is a word the CLI answers, not a command it does not have", async () => {
  const { stdout, code } = await runCli(["help"]);

  assert.equal(code, 0);
  assert.match(stdout, /^commands:$/m);
  assert.doesNotMatch(stdout, /error:/);
});

test("`help <command>` describes that command, the same as `<command> --help`", async () => {
  const { stdout, code } = await runCli(["help", "publish"]);

  assert.equal(code, 0);
  assert.match(stdout, /^command: publish$/m);
  assert.doesNotMatch(stdout, /error:/);
});

test("`help nonsense` fails as the unknown command it names", async () => {
  const { stdout, code } = await runCli(["help", "nonsense"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}message: "?Unknown command: nonsense"?$/m);
});

test("a subcommand's --help describes it instead of running it", async () => {
  const { stdout, code } = await runCli(["open", "--help"]);

  assert.equal(code, 0);
  assert.match(stdout, /^command: open$/m);
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

/** Regression: a mistyped flag was read as a branch name and reported as a bad git ref. */
test("open rejects an unknown flag instead of running with it", async () => {
  const { stdout, code } = await runCli(["open", "feature", "main", "--no-opne", "--intent", "x"]);

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
  for (const command of ["open", "reply", "work", "publish", "end", "serve", "stop", "feedback"]) {
    const { stdout, code } = await runCli([command, "--help"]);

    assert.equal(code, 0, command);
    assert.match(stdout, new RegExp(`^command: ${command}$`, "m"));
  }
});

test("init without --agent names the agents instead of guessing one", async () => {
  const { stdout, code } = await runCli(["init"]);

  assert.equal(code, 2);
  assert.match(stdout, /^ {2}code: agent_missing$/m);
  assert.match(stdout, /pi, claude-code, codex, opencode, vscode/);
});

/** A home directory of its own: a real one would rewrite the skill of whoever runs the suite. */
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
