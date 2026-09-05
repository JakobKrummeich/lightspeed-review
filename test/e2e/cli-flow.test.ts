import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { git, newRepo } from "../helpers/git-repo.ts";
import { freePort } from "../helpers/ports.ts";

/**
 * The whole loop across real process boundaries: CLI spawned as agents spawn it, detached server,
 * reviewer played by HTTP. Under test: stdout, HTTP API, exit codes — what survives refactoring.
 */

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/**
 * A poll with nothing to say blocks forever by design; the kill-switch never fires on the green
 * path (each poll runs once an answer is queued) but a regression must fail, not hang the runner.
 */
const CLI_TIMEOUT_MS = 30_000;

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      timeout: CLI_TIMEOUT_MS,
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? 1 };
  }
}

/**
 * One changed file means the grouping model is skipped outright (`mode: skipped`): no LLM,
 * no credentials, no network beyond loopback — asserted, not assumed.
 */
function repoWithOneFileDiff(port: number): string {
  const repoRoot = newRepo("lsr-e2e-");
  writeFileSync(
    join(repoRoot, ".lightspeed.conf.json"),
    JSON.stringify({
      model: "anthropic/claude-haiku-4-5",
      thinking: "off",
      port,
      // Inside the fixture, so no test ever touches the developer's ~/.lightspeed.
      stateDir: join(repoRoot, "state"),
    }),
  );
  writeFileSync(join(repoRoot, "app.ts"), "const a = 1;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "initial");
  git(repoRoot, "checkout", "-b", "feature");
  writeFileSync(join(repoRoot, "app.ts"), "const a = 2;\n");
  git(repoRoot, "commit", "-am", "change a");
  git(repoRoot, "checkout", "main");
  return repoRoot;
}

/** What the browser sends when the reviewer acts; shapes match `src/browser`. */
function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const annotation = {
  type: "annotation",
  file: "app.ts",
  group: "All Changes",
  side: "new",
  line_start: 1,
  line_end: 1,
  selected_text: "const a = 2;",
  comment: "prefer a named constant",
};

/**
 * `start` leaves a detached server on purpose; tests must not. The shutdown endpoint takes it
 * down, a no-op when nobody listens.
 */
async function shutdownServer(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" }).catch(() => undefined);
}

/** The session key and reviewer URL, read off `start`'s stdout like an agent would. */
function parseStartStdout(stdout: string): { key: string; url: string } {
  const key = /^ {2}key: ([0-9a-f]{16})$/m.exec(stdout)?.[1];
  const url = /^ {2}url: "(http:\/\/127\.0\.0\.1:\d+\/session\/[0-9a-f]{16})"$/m.exec(stdout)?.[1];
  assert.ok(key, `no session key in start output:\n${stdout}`);
  assert.ok(url, `no session url in start output:\n${stdout}`);
  return { key, url };
}

test("the full loop: start, reviewer feedback over HTTP, poll, end, poll, stop", async () => {
  const port = await freePort();
  const repoRoot = repoWithOneFileDiff(port);
  try {
    const started = await runCli(
      ["start", "feature", "--intent", "make a bigger", "--no-open"],
      repoRoot,
    );
    assert.equal(started.code, 0, started.stdout);
    assert.match(started.stdout, /^ {2}status: open$/m);
    // The loop below only holds because no model was consulted.
    assert.match(started.stdout, /^ {2}mode: skipped$/m);
    const { key, url } = parseStartStdout(started.stdout);

    // The URL must serve from the detached server — the process the CLI already exited from.
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);

    // The reviewer ticks the file approved and sends one targeted comment.
    const origin = `http://127.0.0.1:${port}`;
    const approved = await postJson(`${origin}/api/session/${key}/approved`, {
      approved: ["app.ts"],
    });
    assert.equal(approved.status, 200);
    const feedback = await postJson(`${origin}/api/session/${key}/feedback`, {
      prompts: [annotation],
      ended: false,
    });
    assert.equal(feedback.status, 200);

    // Queued feedback answers a later poll immediately: no waiting, no races.
    const polled = await runCli(["poll", "feature", "main"], repoRoot);
    assert.equal(polled.code, 0, polled.stdout);
    assert.match(polled.stdout, /^status: feedback$/m);
    assert.match(polled.stdout, /^ended: false$/m);
    assert.match(polled.stdout, /prefer a named constant/);
    // The minted id is what `poll --for <id>` declarations name later.
    assert.match(polled.stdout, /evt_[a-z0-9]+_\d+/);

    const ended = await runCli(["end", "feature", "main"], repoRoot);
    assert.equal(ended.code, 0, ended.stdout);
    assert.match(ended.stdout, /^ {2}status: ended$/m);

    // An ended session answers a poll at once: who closed it, what approval evidence remains.
    const afterEnd = await runCli(["poll", "feature", "main"], repoRoot);
    assert.equal(afterEnd.code, 0, afterEnd.stdout);
    assert.match(afterEnd.stdout, /^ended: true$/m);
    assert.match(afterEnd.stdout, /^endedBy: agent$/m);
    // The earlier poll took the only comment, so this one has nothing — said, not left blank.
    assert.match(afterEnd.stdout, /^prompts: 0$/m);
    assert.match(afterEnd.stdout, /^message: no feedback was queued when this review ended$/m);
    // A verdict and counts. The paths cost the agent context it did not ask for, so they
    // wait behind the command the same payload points at.
    assert.match(afterEnd.stdout, /^ {2}verdict: signed-off$/m);
    assert.match(afterEnd.stdout, /^ {2}approved: 1$/m);
    assert.match(afterEnd.stdout, /^ {2}swept: 0$/m);
    assert.match(afterEnd.stdout, /^ {2}total: 1$/m);
    assert.match(afterEnd.stdout, /lightspeed approvals feature main/);

    const named = await runCli(["approvals", "feature", "main"], repoRoot);
    assert.equal(named.code, 0, named.stdout);
    assert.match(named.stdout, /^ {2}approved\[1\]: app\.ts$/m);
    assert.match(named.stdout, /^ {2}unapproved: \[\]$/m);
    assert.match(named.stdout, /^ {2}swept: \[\]$/m);
    // A one-file review is printed whole, so the counts beside it report no cut.
    assert.match(named.stdout, /^ {2}total: 1$/m);
    assert.match(named.stdout, /^ {2}has_more: false$/m);
    assert.doesNotMatch(named.stdout, /--full/);

    const stopped = await runCli(["stop"], repoRoot);
    assert.equal(stopped.code, 0, stopped.stdout);
    assert.match(stopped.stdout, /^ {2}status: stopped$/m);

    // Stopping twice proves the server is really gone, in the CLI's own words.
    const stoppedAgain = await runCli(["stop"], repoRoot);
    assert.equal(stoppedAgain.code, 0, stoppedAgain.stdout);
    assert.match(stoppedAgain.stdout, /^ {2}status: not_running$/m);
  } finally {
    await shutdownServer(port);
  }
});

test("a reviewer's Send & End closes the review; only --reopen starts a new round", async () => {
  const port = await freePort();
  const repoRoot = repoWithOneFileDiff(port);
  try {
    const started = await runCli(["start", "feature", "--intent", "why", "--no-open"], repoRoot);
    assert.equal(started.code, 0, started.stdout);
    const { key } = parseStartStdout(started.stdout);

    // "Send & End" in the browser: last words and the end travel together.
    const sendAndEnd = await postJson(`http://127.0.0.1:${port}/api/session/${key}/feedback`, {
      prompts: [annotation],
      ended: true,
    });
    assert.equal(sendAndEnd.status, 200);

    // One poll gets both: the comment and the ending — nothing approved, which must not read as sign-off.
    const polled = await runCli(["poll", "feature", "main"], repoRoot);
    assert.equal(polled.code, 0, polled.stdout);
    assert.match(polled.stdout, /^ended: true$/m);
    assert.match(polled.stdout, /^endedBy: reviewer$/m);
    assert.match(polled.stdout, /prefer a named constant/);
    assert.match(polled.stdout, /^ {2}verdict: none$/m);
    assert.match(polled.stdout, /^ {2}approved: 0$/m);
    assert.match(polled.stdout, /^ {2}unapproved: 1$/m);

    // The agent may not quietly open round two on a review the reviewer ended.
    const refused = await runCli(["start", "feature", "--intent", "again", "--no-open"], repoRoot);
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /^ {2}code: session_ended$/m);

    // The reviewer asked for another round, so --reopen is allowed to give one.
    const reopened = await runCli(
      ["start", "feature", "--intent", "again", "--no-open", "--reopen"],
      repoRoot,
    );
    assert.equal(reopened.code, 0, reopened.stdout);
    assert.match(reopened.stdout, /^ {2}status: open$/m);
  } finally {
    await shutdownServer(port);
  }
});

test("start on a branch git does not know fails before any server exists", async () => {
  const port = await freePort();
  const repoRoot = repoWithOneFileDiff(port);

  try {
    const { stdout, code } = await runCli(
      ["start", "no-such-branch", "--intent", "why", "--no-open"],
      repoRoot,
    );

    assert.equal(code, 1);
    assert.match(stdout, /^ {2}code: git_ref_not_found$/m);
    // Diff is extracted before a server is spawned: a bad ref must leave nothing listening.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  } finally {
    // Belt and braces: keeps a regression-spawned server from outliving the failing test.
    await shutdownServer(port);
  }
});
