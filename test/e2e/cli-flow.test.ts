import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { sessionKey } from "../../src/paths.ts";
import type { SessionRecord } from "../../src/session-types.ts";
import { git, newRepo } from "../helpers/git-repo.ts";
import { freePort } from "../helpers/ports.ts";
import { openStream } from "../helpers/review-server.ts";

/**
 * The whole v3 loop across real process boundaries: the CLI spawned as agents
 * spawn it, a detached server, and the reviewer played over HTTP the way the
 * browser speaks. Under test: stdout, the HTTP API and exit codes — what
 * survives refactoring.
 */

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/**
 * `open`, `reply` and `publish` wait for the reviewer's Send by design; every
 * one here is answered, so the kill-switch never fires on the green path — but
 * a regression must fail, not hang the runner.
 */
const CLI_TIMEOUT_MS = 60_000;

/**
 * Every command checks the skills under HOME and may rewrite one, so no run of
 * the suite may point it at the home of the developer running it.
 */
const isolatedHome = mkdtempSync(join(tmpdir(), "lsr-e2e-home-"));

interface Ran {
  stdout: string;
  code: number;
}

async function runCli(args: string[], cwd: string): Promise<Ran> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, HOME: isolatedHome },
      timeout: CLI_TIMEOUT_MS,
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? 1 };
  }
}

/**
 * One changed file means the grouping model is skipped outright (`mode:
 * skipped`): no LLM, no credentials, no network beyond loopback — asserted,
 * not assumed. The checkout is left on `feature`, where the agent works.
 */
function repoWithOneFileDiff(port: number): string {
  const repoRoot = realpathSync(newRepo("lsr-e2e-"));
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
  writeFileSync(join(repoRoot, ".gitignore"), "state/\n.lightspeed.conf.json\n");
  writeFileSync(join(repoRoot, "app.ts"), "const a = 1;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "initial");
  git(repoRoot, "checkout", "-b", "feature");
  writeFileSync(join(repoRoot, "app.ts"), "const a = 2;\n");
  git(repoRoot, "commit", "-am", "change a");
  return repoRoot;
}

interface Item {
  id: string;
  status: string;
  at?: string;
  you?: string;
  reviewer?: string | string[];
}

interface Answer {
  round?: number;
  turn?: string;
  ended?: boolean;
  endedBy?: string;
  approval?: { verdict: string };
  items?: Item[];
  next?: Record<string, string>;
}

/**
 * The answer a waiting command printed last. `open` and `publish` print the
 * round they opened before the wait and the batch after it — two TOON
 * documents, each led by `round:`.
 */
function answerOf(stdout: string): Answer {
  const starts = [...stdout.matchAll(/^round: /gm)].map((match) => match.index);
  return decode(stdout.slice(starts.at(-1) ?? 0)) as Answer;
}

function item(answer: Answer, id: string): Item {
  const found = answer.items?.find((candidate) => candidate.id === id);
  assert.ok(found, `no item ${id} in ${JSON.stringify(answer)}`);
  return found;
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const question = {
  type: "annotation",
  file: "app.ts",
  group: "All Changes",
  side: "new",
  line_start: 1,
  line_end: 1,
  selected_text: "const a = 2;",
  comment: "why 2?",
};

const changeRequest = { type: "message", comment: "rename a to MAX_RETRIES" };

/**
 * `open` leaves a detached server on purpose; tests must not. The shutdown
 * endpoint takes it down, a no-op when nobody listens.
 */
async function shutdownServer(port: number): Promise<void> {
  await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: "POST" }).catch(() => undefined);
}

/**
 * Resolves once a waiting command has parked on the server — the moment the
 * reviewer's Send reaches an agent instead of a queue. Retried until the
 * session exists: `open` creates it after the command started.
 */
async function untilListening(origin: string, key: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const ready = await fetch(`${origin}/api/session/${key}/data`).catch(() => undefined);
    if (ready?.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const stream = await openStream(origin, key, CLI_TIMEOUT_MS);
  try {
    await stream.until(/"waiting":true/);
  } finally {
    stream.close();
  }
}

async function sessionData(origin: string, key: string): Promise<SessionRecord> {
  return (await (await fetch(`${origin}/api/session/${key}/data`)).json()) as SessionRecord;
}

async function send(origin: string, key: string, prompts: unknown[], ended = false) {
  const sent = await postJson(`${origin}/api/session/${key}/feedback`, { prompts, ended });
  assert.equal(sent.status, 200, await sent.clone().text());
}

interface Loop {
  port: number;
  origin: string;
  repoRoot: string;
  key: string;
}

async function withLoop(body: (loop: Loop) => Promise<void>): Promise<void> {
  const port = await freePort();
  const repoRoot = repoWithOneFileDiff(port);
  const loop = {
    port,
    origin: `http://127.0.0.1:${port}`,
    repoRoot,
    key: sessionKey(repoRoot, "feature", "main"),
  };
  try {
    await body(loop);
  } finally {
    await shutdownServer(port);
  }
}

/** Opens the review and answers its first wait with the reviewer's first batch. */
async function openAnsweredWith(loop: Loop, prompts: unknown[]): Promise<Ran> {
  const opening = runCli(
    ["open", "feature", "--intent", "make a bigger", "--no-open"],
    loop.repoRoot,
  );
  await untilListening(loop.origin, loop.key);
  await send(loop.origin, loop.key, prompts);
  return await opening;
}

test("a whole session: questions, replies, resolve, work, publish, end", async () => {
  await withLoop(async (loop) => {
    const { origin, repoRoot, key } = loop;

    // 1. open: the round is shown before the wait, the first batch after it.
    const opened = await openAnsweredWith(loop, [question, changeRequest]);
    assert.equal(opened.code, 0, opened.stdout);
    assert.match(opened.stdout, /^ {2}mode: skipped$/m, "no model was consulted");
    assert.match(opened.stdout, new RegExp(`^ {2}key: ${key}$`, "m"));
    const first = answerOf(opened.stdout);
    assert.equal(first.turn, "agent digesting");
    assert.partialDeepStrictEqual(item(first, "t1"), {
      status: "new",
      at: "app.ts:1",
      reviewer: "why 2?",
    });
    assert.partialDeepStrictEqual(item(first, "t2"), {
      status: "new",
      reviewer: "rename a to MAX_RETRIES",
    });
    // D5: the decision rule is the last thing printed.
    assert.deepEqual(Object.keys(first).at(-1), "next");
    assert.match(first.next?.talk ?? "", /lightspeed reply --to t1 '<answer>' --to t2/);
    assert.match(first.next?.rule ?? "", /never both/);
    assert.doesNotMatch(opened.stdout, /\bblock(s|ing)?\b/);

    // The page serves from the detached server the CLI left behind.
    const page = await fetch(`${origin}/session/${key}`);
    assert.equal(page.status, 200);

    // 2. reply: one call, the answer under its item; the turn goes back.
    const replying = runCli(
      ["reply", "--to", "t1", "2 is the retry limit", "feature", "main"],
      repoRoot,
    );
    await untilListening(origin, key);
    const afterReply = await sessionData(origin, key);
    assert.equal(afterReply.turn.holder, "reviewer");

    // 3. the reviewer answers in t1 and resolves it (W4: the resolve travels with the Send).
    await postJson(`${origin}/api/session/${key}/approved`, { approved: ["app.ts"] });
    await send(origin, key, [
      { type: "reply", thread: "t1", comment: "fine, keep it" },
      { type: "resolve", thread: "t1", resolved: true },
    ]);
    const replied = await replying;
    assert.equal(replied.code, 0, replied.stdout);
    assert.deepEqual(answerOf(replied.stdout).items, [
      {
        id: "t1",
        status: "resolved",
        at: "app.ts:1",
        selected: "const a = 2;",
        you: "2 is the retry limit",
        reviewer: "fine, keep it",
      },
    ]);

    // 4. work: nothing left to discuss, something to change.
    const working = await runCli(["work", "rename a to MAX_RETRIES", "feature", "main"], repoRoot);
    assert.equal(working.code, 0, working.stdout);
    assert.match(working.stdout, /^turn: "?agent working"?$/m);
    assert.match(working.stdout, /^ {2}publish: .*lightspeed publish feature main/m);

    // Publishing before anything is committed is refused, naming reply.
    const early = await runCli(["publish", "feature", "--intent", "renamed"], repoRoot);
    assert.equal(early.code, 2, early.stdout);
    assert.match(early.stdout, /^ {2}code: nothing_to_publish$/m);
    assert.match(early.stdout, /lightspeed reply --to/);

    // 5. publish: the commit becomes round 2, the note lands in t2.
    writeFileSync(join(repoRoot, "app.ts"), "const MAX_RETRIES = 2;\n");
    git(repoRoot, "commit", "-am", "rename a");
    const publishing = runCli(
      ["publish", "feature", "--intent", "renamed a", "--to", "t2", "done: renamed"],
      repoRoot,
    );
    await untilListening(origin, key);
    const published = await sessionData(origin, key);
    assert.equal(published.rounds.length, 2);
    assert.equal(published.turn.holder, "reviewer");
    assert.deepEqual(published.conversation.at(-1)?.prompts, [
      { type: "reply", thread: "t2", comment: "done: renamed" },
    ]);

    // 6. the reviewer's Send & End answers the waiting publish.
    await postJson(`${origin}/api/session/${key}/approved`, { approved: ["app.ts"] });
    await send(origin, key, [{ type: "resolve", thread: "t2", resolved: true }], true);
    const ended = await publishing;
    assert.equal(ended.code, 0, ended.stdout);
    const last = answerOf(ended.stdout);
    assert.equal(last.round, 2);
    assert.equal(last.ended, true);
    assert.equal(last.endedBy, "reviewer");
    assert.equal(last.approval?.verdict, "signed-off");
    assert.partialDeepStrictEqual(item(last, "t2"), { status: "resolved", you: "done: renamed" });
    assert.deepEqual(Object.keys(last.next ?? {}), ["done"]);

    const named = await runCli(["approvals", "feature", "main"], repoRoot);
    assert.equal(named.code, 0, named.stdout);
    assert.match(named.stdout, /^approved\[1\]: app\.ts$/m);

    const stopped = await runCli(["stop"], repoRoot);
    assert.equal(stopped.code, 0, stopped.stdout);
    assert.match(stopped.stdout, /^ {2}status: stopped$/m);
  });
});

/** D2: no `wait` verb — a waiting command killed mid-wait is re-run as it was. */
test("a reply killed mid-wait is re-run: nothing is posted twice, and the Send still arrives", async () => {
  await withLoop(async (loop) => {
    const { origin, repoRoot, key } = loop;
    const opened = await openAnsweredWith(loop, [question]);
    assert.equal(opened.code, 0, opened.stdout);
    const args = ["reply", "--to", "t1", "2 is the retry limit", "feature", "main"];

    const doomed = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: { ...process.env, HOME: isolatedHome },
      stdio: "ignore",
    });
    await untilListening(origin, key);
    const exited = new Promise((resolve) => doomed.on("exit", resolve));
    doomed.kill("SIGKILL");
    await exited;

    const rerun = runCli(args, repoRoot);
    await untilListening(origin, key);
    const agentSaid = (await sessionData(origin, key)).conversation.filter(
      (entry) => entry.role === "agent",
    );
    assert.equal(agentSaid.length, 1, "the re-run posted nothing");

    await send(origin, key, [{ type: "reply", thread: "t1", comment: "ok" }]);
    const answered = await rerun;
    assert.equal(answered.code, 0, answered.stdout);
    assert.partialDeepStrictEqual(item(answerOf(answered.stdout), "t1"), {
      status: "reply",
      you: "2 is the retry limit",
      reviewer: "ok",
    });

    // `open` re-attaches from anywhere, too: with the agent digesting, it hands the batch back.
    const reattached = await runCli(["open", "feature"], repoRoot);
    assert.equal(reattached.code, 0, reattached.stdout);
    assert.match(reattached.stdout, /re-attached/);
    assert.equal(item(answerOf(reattached.stdout), "t1").reviewer, "ok");
  });
});

/** Finding 1: a leftover waiting command must not take the batch into a terminal nobody reads. */
test("a second open takes over listening: the first exits superseded, the Send reaches the second", async () => {
  await withLoop(async (loop) => {
    const { origin, repoRoot, key } = loop;
    const orphan = runCli(["open", "feature", "--intent", "why", "--no-open"], repoRoot);
    await untilListening(origin, key);

    const current = runCli(["open", "feature", "main"], repoRoot);
    // The orphan is answered the moment the newer command parks.
    const left = await orphan;
    assert.equal(left.code, 0, left.stdout);
    assert.match(left.stdout, /^superseded: true$/m);
    assert.match(left.stdout, /another lightspeed command took over listening/);

    await send(origin, key, [question]);
    const took = await current;
    assert.equal(took.code, 0, took.stdout);
    assert.equal(item(answerOf(took.stdout), "t1").reviewer, "why 2?");
    assert.equal((await sessionData(origin, key)).turn.holder, "agent");
  });
});

test("an ended review refuses open and work; only --reopen starts a new round", async () => {
  await withLoop(async (loop) => {
    const { origin, repoRoot, key } = loop;
    const opening = runCli(["open", "feature", "--intent", "why", "--no-open"], repoRoot);
    await untilListening(origin, key);
    await send(origin, key, [question], true);
    const waited = await opening;
    assert.equal(waited.code, 0, waited.stdout);
    const answer = answerOf(waited.stdout);
    assert.equal(answer.ended, true);
    assert.equal(answer.approval?.verdict, "none");
    assert.equal(item(answer, "t1").reviewer, "why 2?");

    const illegal = await runCli(["work", "carrying on regardless", "feature", "main"], repoRoot);
    assert.equal(illegal.code, 2, illegal.stdout);
    assert.match(illegal.stdout, /^ {2}code: session_ended$/m);

    const refused = await runCli(["open", "feature", "--intent", "again", "--no-open"], repoRoot);
    assert.equal(refused.code, 2, refused.stdout);
    assert.match(refused.stdout, /^ {2}code: session_ended$/m);
    assert.match(refused.stdout, /--reopen/);

    const reopening = runCli(
      ["open", "feature", "--intent", "again", "--no-open", "--reopen"],
      repoRoot,
    );
    await untilListening(origin, key);
    assert.equal((await sessionData(origin, key)).rounds.length, 2);
    await send(origin, key, [], true);
    const reopened = await reopening;
    assert.equal(reopened.code, 0, reopened.stdout);
  });
});

test("a removed verb answers where the next step is instead of running", async () => {
  await withLoop(async ({ repoRoot }) => {
    const { stdout, code } = await runCli(["wait", "feature", "main"], repoRoot);

    assert.equal(code, 2);
    assert.match(stdout, /'wait' was removed in 3\.0, run lightspeed for your next step/);
  });
});

test("open on a branch git does not know fails before any server exists", async () => {
  await withLoop(async ({ port, repoRoot }) => {
    const { stdout, code } = await runCli(
      ["open", "no-such-branch", "--intent", "why", "--no-open"],
      repoRoot,
    );

    assert.equal(code, 1);
    assert.match(stdout, /^ {2}code: git_ref_not_found$/m);
    // Diff is extracted before a server is spawned: a bad ref must leave nothing listening.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
  });
});
