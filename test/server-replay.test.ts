import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session-store.ts";
import { createReviewServer } from "../src/server.ts";
import type { ReplayData } from "../src/rounds/replay.ts";
import { git, newRepo } from "./helpers/git-repo.ts";

/**
 * `GET /api/session/:key/replay` over a real repository, end to end. The
 * cutting and verdict rules themselves are pinned in `test/rounds/replay.test.ts`.
 */

const USERS = "src/api/users.ts";

function repoWith(commits: Record<string, string>): string {
  const repoRoot = newRepo("lsr-replay-");
  mkdirSync(join(repoRoot, "src", "api"), { recursive: true });
  writeFileSync(join(repoRoot, USERS), "const old = 1;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "base");
  for (const [message, contents] of Object.entries(commits)) {
    writeFileSync(join(repoRoot, USERS), contents);
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", message);
  }
  return repoRoot;
}

/** The last `count` commits of the branch, oldest first. */
function commitLine(repoRoot: string, count: number): string[] {
  return git(repoRoot, "rev-list", "--reverse", `-${count}`, "HEAD").split("\n");
}

/** One round's payload with the blob shas the repository really holds. */
function roundPayload(repoRoot: string, baseCommit: string, headCommit: string): unknown {
  const before = git(repoRoot, "rev-parse", `${baseCommit}:${USERS}`);
  const after = git(repoRoot, "rev-parse", `${headCommit}:${USERS}`);
  return {
    repoRoot,
    branch: "feature",
    base: "main",
    baseCommit,
    headCommit,
    intents: ["number the constant"],
    commits: ["renumber"],
    groups: [
      {
        name: "API Handlers",
        rationale: "request handling",
        files: [
          {
            path: USERS,
            status: "modified",
            diff: `index ${before}..${after} 100644\n@@ -1 +1 @@\n-old\n+new`,
            insertions: 1,
            deletions: 1,
            oversized: false,
          },
        ],
      },
    ],
  };
}

interface Harness {
  url: string;
  store: SessionStore;
  repoRoot: string;
  key: string;
  commits: string[];
  stop(): Promise<void>;
}

/** A running server holding one session on its first round over a real repo. */
async function startReview(commits: Record<string, string>): Promise<Harness> {
  const repoRoot = repoWith(commits);
  const line = commitLine(repoRoot, Object.keys(commits).length + 1);
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-replay-state-")));
  const server = createReviewServer({ store, port: 0 });
  const { url } = await server.start();
  const response = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(roundPayload(repoRoot, line[0]!, line[1]!)),
  });
  const { key } = (await response.json()) as { key: string };
  return { url, store, repoRoot, key, commits: line, stop: () => server.stop() };
}

/** The reviewer comments on line 1 of the file, and the server mints the id. */
async function annotate(harness: Harness): Promise<string> {
  const response = await fetch(`${harness.url}/api/session/${harness.key}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ended: false,
      prompts: [
        {
          type: "annotation",
          file: USERS,
          group: "API Handlers",
          selected_text: "+const fresh = 2;",
          comment: "name it after what it counts",
          side: "new",
          line_start: 1,
          line_end: 1,
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const prompt = harness.store.get(harness.key)?.conversation.at(-1)?.prompts[0];
  assert.ok(prompt?.type === "annotation" && prompt.id !== undefined);
  return prompt.id;
}

async function nextRound(harness: Harness, headCommit: string): Promise<void> {
  const response = await fetch(`${harness.url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(roundPayload(harness.repoRoot, harness.commits[0]!, headCommit)),
  });
  assert.equal(response.status, 200);
}

async function declare(harness: Harness, id: string): Promise<void> {
  const response = await fetch(`${harness.url}/api/session/${harness.key}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      comment: "renamed it",
      declarations: [{ id, note: "now it counts users", files: [USERS] }],
    }),
  });
  assert.equal(response.status, 200);
}

async function readReplay(harness: Harness): Promise<ReplayData> {
  const response = await fetch(`${harness.url}/api/session/${harness.key}/replay`);
  assert.equal(response.status, 200);
  return (await response.json()) as ReplayData;
}

test("the replay endpoint serves a declared comment with its note and real hunks", async () => {
  const harness = await startReview({
    "Take the users handler off the old constant": "const fresh = 2;\n",
    "Name the constant after what it counts": "const users = 2;\n",
  });
  try {
    const id = await annotate(harness);
    await nextRound(harness, harness.commits[2]!);
    await declare(harness, id);

    const { comments } = await readReplay(harness);

    assert.equal(comments.length, 1);
    const [card] = comments;
    assert.equal(card?.id, id);
    assert.equal(card?.file, USERS);
    assert.deepEqual(card?.anchor, { side: "new", line_start: 1, line_end: 1 });
    assert.equal(card?.declared, true);
    assert.equal(card?.note, "now it counts users");
    assert.equal(card?.state, "ok");
    assert.equal(card?.status, "addressed");
    assert.equal(card?.answers[0]?.file, USERS);
    const body = card?.answers[0]?.hunks[0]?.body ?? "";
    assert.match(body, /-const fresh = 2;/);
    assert.match(body, /\+const users = 2;/);
    assert.equal(card?.context, "const fresh = 2;\n", "the code the comment was made on");
  } finally {
    await harness.stop();
  }
});

test("an undeclared comment falls back to anchor-matched hunks, without a note", async () => {
  const harness = await startReview({
    "Take the users handler off the old constant": "const fresh = 2;\n",
    "Name the constant after what it counts": "const users = 2;\n",
  });
  try {
    await annotate(harness);
    await nextRound(harness, harness.commits[2]!);

    const { comments } = await readReplay(harness);

    const [card] = comments;
    assert.equal(card?.declared, false);
    assert.equal(card?.note, undefined);
    assert.equal(card?.status, "addressed");
    assert.equal(card?.answers.length, 1);
    assert.match(card?.answers[0]?.hunks[0]?.body ?? "", /\+const users = 2;/);
  } finally {
    await harness.stop();
  }
});

test("a first round has nothing to replay, and says so with an empty list, not a 404", async () => {
  const harness = await startReview({ "Fresh constant": "const fresh = 2;\n" });
  try {
    await annotate(harness);

    assert.deepEqual(await readReplay(harness), { comments: [] });
  } finally {
    await harness.stop();
  }
});

test("history a force-push rewrote degrades to status-only cards, never blocking", async () => {
  const harness = await startReview({
    "Take the users handler off the old constant": "const fresh = 2;\n",
    "Name the constant after what it counts": "const users = 2;\n",
  });
  try {
    const id = await annotate(harness);
    await nextRound(harness, harness.commits[2]!);
    await declare(harness, id);
    git(harness.repoRoot, "reset", "--hard", "HEAD~2");
    git(harness.repoRoot, "reflog", "expire", "--expire=now", "--all");
    git(harness.repoRoot, "gc", "--prune=now", "--quiet");

    const { comments } = await readReplay(harness);

    const [card] = comments;
    assert.equal(card?.state, "unreachable");
    assert.equal(card?.status, "unknown");
    assert.deepEqual(card?.answers, []);
    assert.equal(card?.note, "now it counts users", "the agent's word survives the rewrite");
  } finally {
    await harness.stop();
  }
});

test("the replay of a session nobody started is a 404, same as every other read", async () => {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-replay-state-")));
  const server = createReviewServer({ store, port: 0 });
  const { url } = await server.start();
  try {
    const response = await fetch(`${url}/api/session/no-such/replay`);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: { code: "session_not_found", message: "no session no-such" },
    });
  } finally {
    await server.stop();
  }
});
