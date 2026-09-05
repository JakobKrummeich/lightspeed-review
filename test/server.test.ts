import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { SessionStore } from "../src/session-store.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import type { AnnotationRecord } from "../src/ledger/records.ts";
import { createReviewServer, type ReviewServer } from "../src/server.ts";
import { ReviewError } from "../src/errors.ts";
import { MAX_APPROVED_FORM_BYTES } from "../src/rounds/approved-form.ts";
import { sessionKey } from "../src/paths.ts";
import { git, newRepo } from "./helpers/git-repo.ts";

interface RunningServer {
  server: ReviewServer;
  url: string;
  store: SessionStore;
}

interface ServerOptions {
  staticDir?: string;
  ledger?: LedgerStore;
}

async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-server-")));
  const server = createReviewServer({ store, port: 0, ...options });
  const { url } = await server.start();
  return { server, url, store };
}

async function withServer(
  body: (running: RunningServer) => Promise<void>,
  options: ServerOptions = {},
): Promise<void> {
  const running = await startServer(options);
  try {
    await body(running);
  } finally {
    await running.server.stop();
  }
}

const sessionPayload = {
  repoRoot: "/repo",
  branch: "feature-auth",
  base: "main",
  intents: ["replace session cookies with signed tokens"],
  commits: ["sign the tokens"],
  groups: [
    {
      name: "API Handlers",
      rationale: "request handling",
      files: [
        {
          path: "src/api/users.ts",
          status: "modified",
          diff: "index 11ab34c..4c9f88d 100644\n@@ -1 +1 @@\n-old\n+new",
          insertions: 1,
          deletions: 1,
          oversized: false,
        },
      ],
    },
  ],
};

/** The same file, edited again by the agent: a new new-side blob sha. */
function editedPayload(index: string): unknown {
  const file = sessionPayload.groups[0]!.files[0]!;
  return {
    ...sessionPayload,
    groups: [
      {
        ...sessionPayload.groups[0]!,
        files: [{ ...file, diff: `${index}\n@@ -1 +1 @@\n-new\n+newer` }],
      },
    ],
  };
}

function postApproved(url: string, key: string, approved: string[]): Promise<Response> {
  return fetch(`${url}/api/session/${key}/approved`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved }),
  });
}

async function postSession(url: string): Promise<{ key: string; url: string }> {
  const response = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionPayload),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { key: string; url: string };
}

function postSessionRaw(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function endedSession(url: string, store: SessionStore): Promise<string> {
  const { key } = await postSession(url);
  await fetch(`${url}/api/session/${key}/end`, { method: "POST" });
  assert.equal(store.get(key)?.status, "ended");
  return key;
}

test("a round posted to a review the reviewer ended is refused and changes nothing", async () => {
  await withServer(async ({ url, store }) => {
    const key = await endedSession(url, store);
    const before = store.get(key)!;

    const response = await postSessionRaw(url, sessionPayload);

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: {
        code: "session_ended",
        message: "the reviewer ended this review; only they ask for a new round",
      },
    });
    assert.deepEqual(store.get(key), before);
  });
});

/**
 * Bodies outside the three modes are dropped rather than stored; absent reads as `llm`,
 * which is what every round written before the field does.
 */
test("a round records how its grouping was arrived at, and only if it is a real mode", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    assert.equal(store.get(key)?.rounds.at(-1)?.grouping, undefined);

    await postSessionRaw(url, { ...sessionPayload, grouping: "fallback" });
    await postSessionRaw(url, { ...sessionPayload, grouping: "banana" });

    assert.deepEqual(
      store.get(key)?.rounds.map((round) => round.grouping),
      [undefined, "fallback", undefined],
    );
  });
});

test("a refused round writes nothing to the ledger", async () => {
  const ledger = new LedgerStore(mkdtempSync(join(tmpdir(), "lsr-ledger-")));
  await withServer(
    async ({ url, store }) => {
      await endedSession(url, store);
      const before = ledger.read({}).matched;
      assert.ok(before > 0, "the ended round should already be on record");

      await postSessionRaw(url, sessionPayload);

      assert.equal(ledger.read({}).matched, before);
    },
    { ledger },
  );
});

test("a round posted with reopen opens the review again and keeps its history", async () => {
  await withServer(async ({ url, store }) => {
    const key = await endedSession(url, store);
    const rounds = store.get(key)!.rounds.length;

    const response = await postSessionRaw(url, { ...sessionPayload, reopen: true });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "open");
    const session = store.get(key)!;
    assert.equal(session.status, "open");
    assert.equal(session.rounds.length, rounds + 1);
  });
});

test("health reports ok", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});

test("posting a session stores it under its session key and returns its url", async () => {
  await withServer(async ({ url, store }) => {
    const created = await postSession(url);

    const expectedKey = sessionKey("/repo", "feature-auth", "main");
    assert.equal(created.key, expectedKey);
    assert.equal(created.url, `${url}/session/${expectedKey}`);
    assert.equal(store.get(expectedKey)?.branch, "feature-auth");
  });
});

test("posting the same branch pair twice updates the session instead of duplicating it", async () => {
  await withServer(async ({ url, store }) => {
    const first = await postSession(url);
    const second = await postSession(url);

    assert.equal(first.key, second.key);
    assert.equal(store.list().length, 1);
  });
});

test("re-posting a session preserves the conversation and the approvals it can vouch for", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    const stored = store.get(key)!;
    store.save({
      ...stored,
      approved: ["src/api/users.ts"],
      conversation: [{ role: "reviewer", at: "2025-01-01T00:00:00.000Z", prompts: [] }],
    });

    await postSession(url);

    const updated = store.get(key)!;
    // File unmoved since the tick, so the reviewer is not asked to read it again.
    assert.deepEqual(updated.approved, ["src/api/users.ts"]);
    assert.equal(updated.conversation.length, 1);
  });
});

test("an approval sent to the agent without ending the round survives the next start", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);
    await fetch(`${url}/api/session/${key}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [{ type: "message", comment: "one more pass" }] }),
    });

    await postSession(url);

    const session = store.get(key)!;
    assert.deepEqual(session.approved, ["src/api/users.ts"]);
    assert.deepEqual(
      session.rounds.map((round) => round.approvedAtEnd),
      [["src/api/users.ts"], []],
    );
  });
});

test("un-ticking a carried approval sticks, in the answer now and in the next round", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);
    await postSession(url);
    assert.deepEqual(store.get(key)?.approved, ["src/api/users.ts"]);

    await postApproved(url, key, []);

    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      approval: Record<string, string>;
    };
    assert.deepEqual(data.approval, { "src/api/users.ts": "unapproved" });
    await postSession(url);
    assert.deepEqual(store.get(key)?.approved, []);
  });
});

test("every round but the one being reviewed has been closed on what was ticked", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);
    await postSession(url);
    await postSession(url);

    const rounds = store.get(key)!.rounds;
    assert.equal(rounds.length, 3);
    // Closed rounds record what was ticked when they stopped being current; the open one says nothing yet.
    assert.deepEqual(
      rounds.map((round) => round.approvedAtEnd),
      [["src/api/users.ts"], ["src/api/users.ts"], []],
    );
  });
});

test("a tick posted after the reviewer ended the review is refused", async () => {
  await withServer(async ({ url, store }) => {
    const key = await endedSession(url, store);
    const before = store.get(key)!;

    const response = await postApproved(url, key, ["src/api/users.ts"]);

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: {
        code: "session_ended",
        message: "this review is ended; its approvals are what the reviewer left",
      },
    });
    assert.deepEqual(store.get(key), before);
  });
});

test("a file the agent edited after it was approved comes back needing re-approval", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);

    await postSessionRaw(url, editedPayload("index 4c9f88d..7d5e213 100644"));

    assert.deepEqual(store.get(key)?.approved, []);
    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      approval: Record<string, string>;
    };
    assert.deepEqual(data.approval, { "src/api/users.ts": "needs-reapproval" });
  });
});

test("an approved deletion is carried into the next round", async () => {
  await withServer(async ({ url, store }) => {
    const deletion = {
      ...sessionPayload,
      groups: [
        {
          name: "Removals",
          rationale: "dead code",
          files: [
            {
              path: "src/api/users.ts",
              status: "deleted",
              diff: "index 11ab34c..0000000 100644\n@@ -1 +0,0 @@\n-old",
              insertions: 0,
              deletions: 1,
              oversized: false,
            },
          ],
        },
      ],
    };
    await postSessionRaw(url, deletion);
    const key = sessionKey("/repo", "feature-auth", "main");
    await postApproved(url, key, ["src/api/users.ts"]);

    await postSessionRaw(url, deletion);

    assert.deepEqual(store.get(key)?.approved, ["src/api/users.ts"]);
  });
});

test("posting a session appends a round holding each file's blob", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    assert.deepEqual(store.get(key)?.rounds, [
      {
        index: 0,
        round: store.get(key)!.round,
        at: store.get(key)!.updatedAt,
        intents: ["replace session cookies with signed tokens"],
        commits: ["sign the tokens"],
        files: [{ path: "src/api/users.ts", status: "modified", blob: "4c9f88d" }],
        approvedAtEnd: [],
      },
    ]);
  });
});

test("ending a session closes its round with the files approved at the time", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await fetch(`${url}/api/session/${key}/approved`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: ["src/api/users.ts"] }),
    });

    await fetch(`${url}/api/session/${key}/end`, { method: "POST" });

    assert.deepEqual(store.get(key)?.rounds?.at(-1)?.approvedAtEnd, ["src/api/users.ts"]);
  });
});

test("send-and-end closes the round, and the next start opens another", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await fetch(`${url}/api/session/${key}/approved`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: ["src/api/users.ts"] }),
    });
    await fetch(`${url}/api/session/${key}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [{ type: "message", comment: "ship it" }], ended: true }),
    });

    await postSessionRaw(url, { ...sessionPayload, reopen: true });

    const rounds = store.get(key)?.rounds ?? [];
    assert.deepEqual(
      rounds.map((entry) => [entry.index, entry.approvedAtEnd]),
      [
        [0, ["src/api/users.ts"]],
        [1, []],
      ],
    );
  });
});

test("a retired `journeys` field from an older CLI is dropped, not a 400", async () => {
  await withServer(async ({ url, store }) => {
    // Journeys shipped and were withdrawn: an older CLI still posts them, and the server ignores them.
    const response = await postSessionRaw(url, {
      ...sessionPayload,
      journeys: [{ protagonist: "a token", stations: [] }],
    });

    assert.equal(response.status, 200);
    const key = sessionKey("/repo", "feature-auth", "main");
    assert.equal("journeys" in store.get(key)!, false);
  });
});

test("the data endpoint serves the round's stated intent and the branch's commits", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      intents: string[];
      commits: string[];
    };

    assert.deepEqual(data.intents, ["replace session cookies with signed tokens"]);
    assert.deepEqual(data.commits, ["sign the tokens"]);
  });
});

test("the data endpoint calls a file of the first round unapproved", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      approval: Record<string, string>;
    };

    assert.deepEqual(data.approval, { "src/api/users.ts": "unapproved" });
  });
});

test("the data endpoint calls a file approved earlier and untouched approved", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    const first = store.get(key)!;
    store.save({
      ...first,
      approved: ["src/api/users.ts"],
      rounds: [{ ...first.rounds[0]!, approvedAtEnd: ["src/api/users.ts"] }],
    });
    await postSession(url);

    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      approval: Record<string, string>;
    };

    assert.deepEqual(data.approval, { "src/api/users.ts": "approved" });
  });
});

test("the data endpoint calls a file nobody approved unapproved on its second round", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    await postSession(url);

    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      approval: Record<string, string>;
    };

    assert.deepEqual(data.approval, { "src/api/users.ts": "unapproved" });
  });
});

test("a session file without rounds is refused instead of read as historyless", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    const stored = store.get(key)!;
    const withoutRounds: Partial<typeof stored> = { ...stored };
    delete withoutRounds.rounds;
    store.save(withoutRounds as typeof stored);

    assert.throws(() => store.get(key), /has no rounds/);
  });
});

test("the review page renders for a known session", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/session/${key}`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /feature-auth/);
  });
});

test("an unknown session page is a 404", async () => {
  await withServer(async ({ url }) => {
    assert.equal((await fetch(`${url}/session/deadbeefdeadbeef`)).status, 404);
  });
});

test("the session data endpoint returns the stored groups", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      branch: string;
      groups: { name: string }[];
    };

    assert.equal(data.branch, "feature-auth");
    assert.deepEqual(
      data.groups.map((group) => group.name),
      ["API Handlers"],
    );
  });
});

/** A real repository, because the file endpoint answers out of git, not the session. */
async function withFileSession(
  body: (running: RunningServer & { key: string }) => Promise<void>,
  options: ServerOptions = {},
): Promise<void> {
  const repoRoot = newRepo("lsr-file-");
  mkdirSync(join(repoRoot, "src", "api"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "api", "users.ts"), "const old = 1;\n");
  writeFileSync(join(repoRoot, "secret.env"), "TOKEN=1\n");
  writeFileSync(join(repoRoot, "notes.md"), "# notes\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "base");
  const baseCommit = git(repoRoot, "rev-parse", "HEAD");
  writeFileSync(join(repoRoot, "src", "api", "users.ts"), "const fresh = 2;\n");
  git(repoRoot, "mv", "notes.md", "docs.md");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "work");
  const headCommit = git(repoRoot, "rev-parse", "HEAD");

  await withServer(async (running) => {
    const response = await fetch(`${running.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...sessionPayload,
        repoRoot,
        baseCommit,
        headCommit,
        groups: [
          {
            ...sessionPayload.groups[0],
            files: [
              ...sessionPayload.groups[0]!.files,
              {
                path: "docs.md",
                previousPath: "notes.md",
                status: "renamed",
                diff: "",
                insertions: 0,
                deletions: 0,
                oversized: false,
              },
            ],
          },
        ],
      }),
    });
    const { key } = (await response.json()) as { key: string };
    await body({ ...running, key });
  }, options);
}

test("the file endpoint serves both versions of a file under review", async () => {
  await withFileSession(async ({ url, key }) => {
    const read = async (side: string) =>
      (await (
        await fetch(`${url}/api/session/${key}/file?path=src/api/users.ts&side=${side}`)
      ).json()) as { contents: string };

    assert.equal((await read("old")).contents, "const old = 1;\n");
    assert.equal((await read("new")).contents, "const fresh = 2;\n");
  });
});

test("the old version of a renamed file is read under the name it had then", async () => {
  await withFileSession(async ({ url, key }) => {
    const read = async (side: string) =>
      await (await fetch(`${url}/api/session/${key}/file?path=docs.md&side=${side}`)).json();

    assert.deepEqual(await read("old"), { path: "docs.md", side: "old", contents: "# notes\n" });
    assert.equal(((await read("new")) as { contents: string }).contents, "# notes\n");
  });
});

test("an annotation is logged with the code around it, read out of git", async () => {
  const ledger = new LedgerStore(mkdtempSync(join(tmpdir(), "lsr-ledger-")));

  await withFileSession(
    async ({ url, key }) => {
      await fetch(`${url}/api/session/${key}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ended: false,
          prompts: [
            {
              type: "annotation",
              file: "src/api/users.ts",
              group: "API Handlers",
              selected_text: "const old = 1;",
              comment: "why?",
              side: "old",
              line_start: 1,
              line_end: 1,
            },
          ],
        }),
      });

      const annotation = ledger
        .read({})
        .records.find((record) => record.kind === "annotation") as AnnotationRecord;
      assert.equal(annotation.context, "const old = 1;\n");
      assert.equal(annotation.context_source, "anchor");
    },
    { ledger },
  );
});

test("the file endpoint serves nothing but the paths this review lists", async () => {
  await withFileSession(async ({ url, key }) => {
    const forbidden = ["secret.env", "../../../etc/passwd", ""];

    for (const path of forbidden) {
      const response = await fetch(
        `${url}/api/session/${key}/file?path=${encodeURIComponent(path)}&side=new`,
      );
      assert.equal(response.status, 404, path);
    }
  });
});

test("the file endpoint is a 404 for a session with no resolved commits", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/file?path=src/api/users.ts&side=new`);

    assert.equal(response.status, 404);
  });
});

const USERS = "src/api/users.ts";

/**
 * One round's payload with the blob shas git would really print, so round metadata and git agree;
 * a hand-written sha would let a test reach a state the reviewer never can.
 */
function usersRound(repoRoot: string, baseCommit: string, commit: string, round: object = {}) {
  const before = git(repoRoot, "rev-parse", `${baseCommit}:${USERS}`);
  const after = git(repoRoot, "rev-parse", `${commit}:${USERS}`);
  const file = sessionPayload.groups[0]!.files[0]!;
  return {
    ...sessionPayload,
    repoRoot,
    baseCommit,
    headCommit: commit,
    groups: [
      {
        ...sessionPayload.groups[0]!,
        files: [{ ...file, diff: `index ${before}..${after} 100644\n@@ -1 +1 @@\n-old\n+new` }],
      },
    ],
    ...round,
  };
}

/** A repository with a base commit, the approved commit, and whatever came after. */
function reapprovalRepo(prefix: string, commits: Record<string, string | Buffer>): string {
  const repoRoot = newRepo(prefix);
  mkdirSync(join(repoRoot, "src", "api"), { recursive: true });
  writeFileSync(join(repoRoot, USERS), "const old = 1;\n");
  writeFileSync(join(repoRoot, "secret.env"), "TOKEN=1\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "base");
  for (const [message, contents] of Object.entries(commits)) {
    writeFileSync(join(repoRoot, USERS), contents);
    git(repoRoot, "add", ".");
    git(repoRoot, "commit", "-m", message);
  }
  return repoRoot;
}

interface Reapproval extends RunningServer {
  key: string;
  repoRoot: string;
  approvedAt: string;
  head: string;
}

/** The two rounds the approved-form toggle is about, over a repository git can answer for. */
async function withReapprovalSession(
  body: (running: Reapproval) => Promise<void>,
  after: string | Buffer = "const fresher = 3;\n",
  approve = true,
): Promise<void> {
  const repoRoot = reapprovalRepo("lsr-reapproval-", {
    "Take the users handler off the old constant": "const fresh = 2;\n",
    "Number the constant the way the caller reads it": after,
  });
  const [baseCommit, approvedAt, head] = commitLine(repoRoot, 3);

  await withServer(async (running) => {
    const { key } = (await (
      await postSessionRaw(running.url, usersRound(repoRoot, baseCommit!, approvedAt!))
    ).json()) as { key: string };
    if (approve) await postApproved(running.url, key, [USERS]);
    await postSessionRaw(running.url, usersRound(repoRoot, baseCommit!, head!));
    await body({ ...running, key, repoRoot, approvedAt: approvedAt!, head: head! });
  });
}

/** The same two rounds with the approval never given, which is the last-round toggle's home. */
function withUnapprovedRounds(body: (running: Reapproval) => Promise<void>): Promise<void> {
  return withReapprovalSession(body, undefined, false);
}

/** The last `count` commits of the branch, oldest first. */
function commitLine(repoRoot: string, count: number): string[] {
  return git(repoRoot, "rev-list", "--reverse", `-${count}`, "HEAD").split("\n");
}

function approvedForm(url: string, key: string, path: string): Promise<Response> {
  return fetch(`${url}/api/session/${key}/approved-form?path=${encodeURIComponent(path)}`);
}

test("the approved-form endpoint diffs the approving round's head against today's", async () => {
  await withReapprovalSession(async ({ url, key, approvedAt, head }) => {
    const response = await approvedForm(url, key, "src/api/users.ts");

    assert.equal(response.status, 200);
    const data = (await response.json()) as Record<string, unknown>;
    assert.equal(data.state, "diff");
    assert.equal(data.from, approvedAt);
    assert.equal(data.to, head);
    assert.deepEqual(data.paths, [USERS], "every name git was given, for the reviewer to reuse");
    assert.match(String(data.diff), /-const fresh = 2;/);
    assert.match(String(data.diff), /\+const fresher = 3;/);
    assert.equal(data.since, undefined, "the rounds in between are the panel's job, not this");
  });
});

test("a file whose approval nothing undid has no approved form to ask for", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);

    const response = await approvedForm(url, key, "src/api/users.ts");

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: "no_approved_form",
        message: "src/api/users.ts has no approval for this round to be read against",
      },
    });
  });
});

test("the approved-form endpoint serves nothing but the paths this review lists", async () => {
  await withReapprovalSession(async ({ url, key }) => {
    for (const path of ["secret.env", "../../../etc/passwd", ""]) {
      assert.equal((await approvedForm(url, key, path)).status, 404, path);
    }
  });
});

test("a file edited and put back reads as identical to the form the reviewer approved", async () => {
  // Three rounds: approved, edited, edited back. The ends hold the same bytes — "no diff" is
  // honest, an empty patch would read as "nothing happened".
  const repoRoot = reapprovalRepo("lsr-restored-", {
    "Take the users handler off the old constant": "const fresh = 2;\n",
    "Try the constant the other way round": "const other = 9;\n",
    "Put the constant back where the reviewer left it": "const fresh = 2;\n",
  });
  const [baseCommit, approvedAt, changed, head] = commitLine(repoRoot, 4);

  await withServer(async ({ url }) => {
    const { key } = (await (
      await postSessionRaw(url, usersRound(repoRoot, baseCommit!, approvedAt!))
    ).json()) as { key: string };
    await postApproved(url, key, [USERS]);
    await postSessionRaw(url, usersRound(repoRoot, baseCommit!, changed!));
    await postSessionRaw(url, usersRound(repoRoot, baseCommit!, head!));

    const data = (await (await approvedForm(url, key, USERS)).json()) as {
      state: string;
      diff?: string;
    };

    assert.equal(data.state, "identical");
    assert.equal(data.diff, undefined);
  });
});

test("a file that has become binary is named as that, not served as an empty diff", async () => {
  // Approved as text, now binary: git has no lines to show.
  await withReapprovalSession(
    async ({ url, key }) => {
      const data = (await (await approvedForm(url, key, USERS)).json()) as {
        state: string;
        diff?: string;
      };

      assert.equal(data.state, "binary");
      assert.equal(data.diff, undefined);
    },
    Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]),
  );
});

test("a patch past the render cap is measured in bytes and offered to git instead", async () => {
  const huge = `${"const padding = 1;\n".repeat(40_000)}`;
  assert.ok(Buffer.byteLength(huge) > MAX_APPROVED_FORM_BYTES, "the fixture clears the cap");

  await withReapprovalSession(async ({ url, key }) => {
    const data = (await (await approvedForm(url, key, USERS)).json()) as {
      state: string;
      diff?: string;
      bytes?: number;
    };

    assert.equal(data.state, "oversize");
    assert.equal(data.diff, undefined, "half a patch is worse than none");
    assert.ok((data.bytes ?? 0) > MAX_APPROVED_FORM_BYTES);
  }, huge);
});

test("a commit a rebase took away is reported as unreconstructable, never guessed", async () => {
  // The pair is the test: the same repo answers with a diff while the commits exist, and stops
  // only once they are really gone.
  await withReapprovalSession(async ({ url, key, repoRoot }) => {
    assert.equal(
      ((await (await approvedForm(url, key, USERS)).json()) as { state: string }).state,
      "diff",
    );

    // What a rebase/force-push leaves: branch points elsewhere, nothing reaches the reviewed commits.
    git(repoRoot, "reset", "--hard", "HEAD~2");
    git(repoRoot, "reflog", "expire", "--expire=now", "--all");
    git(repoRoot, "gc", "--prune=now", "--quiet");

    const data = (await (await approvedForm(url, key, USERS)).json()) as {
      state: string;
      diff?: string;
    };

    assert.equal(data.state, "unreachable");
    assert.equal(data.diff, undefined);
  });
});

test("a review too old to have recorded commits says so, and blames no rebase", async () => {
  // Sessions written before commits were stored never resolved one. Nothing was rewritten, and
  // claiming so would send the reviewer hunting a force-push that never happened.
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postApproved(url, key, [USERS]);
    await postSessionRaw(url, editedPayload("index 4c9f88d..7d5e213 100644"));
    assert.equal(store.get(key)?.rounds.at(-1)?.headCommit, undefined);

    const data = (await (await approvedForm(url, key, USERS)).json()) as {
      state: string;
      diff?: string;
    };

    assert.equal(data.state, "unrecorded");
    assert.equal(data.diff, undefined);
  });
});

function lastRoundForm(url: string, key: string, path: string): Promise<Response> {
  return fetch(`${url}/api/session/${key}/last-round-form?path=${encodeURIComponent(path)}`);
}

test("the last-round-form endpoint diffs the previous round's head against today's", async () => {
  await withUnapprovedRounds(async ({ url, key, approvedAt, head }) => {
    const response = await lastRoundForm(url, key, USERS);

    assert.equal(response.status, 200);
    const data = (await response.json()) as Record<string, unknown>;
    assert.equal(data.state, "diff");
    assert.equal(data.from, approvedAt, "the head of the round the reviewer last read");
    assert.equal(data.to, head);
    assert.deepEqual(data.paths, [USERS]);
    assert.match(String(data.diff), /-const fresh = 2;/);
    assert.match(String(data.diff), /\+const fresher = 3;/);
  });
});

test("a needs-reapproval file keeps the approved form and never carries this one", async () => {
  // With the approval given, everything since the tick is the approved form's answer: one file
  // never carries two comparisons.
  await withReapprovalSession(async ({ url, key }) => {
    const response = await lastRoundForm(url, key, USERS);

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: {
        code: "no_last_round_form",
        message: "src/api/users.ts did not change between the last two rounds",
      },
    });
    assert.equal((await approvedForm(url, key, USERS)).status, 200);
  });
});

test("a file that stood still between the rounds has no last-round form", async () => {
  // Two rounds over the same head: blobs match, no second diff to offer.
  const repoRoot = reapprovalRepo("lsr-unmoved-", {
    "Take the users handler off the old constant": "const fresh = 2;\n",
  });
  const [baseCommit, head] = commitLine(repoRoot, 2);

  await withServer(async ({ url }) => {
    const { key } = (await (
      await postSessionRaw(url, usersRound(repoRoot, baseCommit!, head!))
    ).json()) as { key: string };
    await postSessionRaw(url, usersRound(repoRoot, baseCommit!, head!));

    assert.equal((await lastRoundForm(url, key, USERS)).status, 404);
  });
});

test("a review on its first round has no last round to be read against", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    assert.equal((await lastRoundForm(url, key, USERS)).status, 404);
  });
});

test("the last-round-form endpoint serves nothing but the paths this review lists", async () => {
  await withUnapprovedRounds(async ({ url, key }) => {
    for (const path of ["secret.env", "../../../etc/passwd", ""]) {
      assert.equal((await lastRoundForm(url, key, path)).status, 404, path);
    }
  });
});

const annotation = {
  type: "annotation",
  file: "src/api/users.ts",
  group: "API Handlers",
  selected_text: "+const user = 1;",
  comment: "wrap in a transaction",
};

async function postFeedback(
  url: string,
  key: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${url}/api/session/${key}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("posted feedback is queued for the agent and recorded in the conversation", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    const { status } = await postFeedback(url, key, { prompts: [annotation], ended: false });

    assert.equal(status, 200);
    const session = store.get(key)!;
    assert.partialDeepStrictEqual(session.pending, [annotation]);
    // The server mints the id (no ledger configured): the id is how the agent names the comment back.
    assert.match((session.pending[0] as { id?: string }).id ?? "", /^evt_/);
    assert.equal(session.status, "feedback");
    assert.equal(session.conversation.at(-1)?.role, "reviewer");
    assert.deepEqual(session.conversation.at(-1)?.prompts, session.pending);
  });
});

test("an id the browser claims for a prompt is stripped, never trusted", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    const { status } = await postFeedback(url, key, {
      prompts: [{ ...annotation, id: "evt_forged_0001" }],
      ended: false,
    });

    assert.equal(status, 200);
    const id = (store.get(key)!.pending[0] as { id?: string }).id;
    assert.notEqual(id, "evt_forged_0001");
    assert.match(id ?? "", /^evt_/);
  });
});

test("a poll hands the agent each annotation under its minted id", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postFeedback(url, key, { prompts: [annotation], ended: false });
    const minted = (store.get(key)!.pending[0] as { id?: string }).id;

    const payload = (await (await fetch(`${url}/api/poll?key=${key}`)).json()) as {
      prompts: { id?: string }[];
    };

    assert.match(minted ?? "", /^evt_/);
    assert.equal(payload.prompts[0]?.id, minted);
  });
});

test("feedback sent with ended closes the session", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    await postFeedback(url, key, {
      prompts: [{ type: "message", comment: "ship it" }],
      ended: true,
    });

    assert.equal(store.get(key)?.status, "ended");
  });
});

test("a reviewer who approved everything can end without saying anything", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    const { status, json } = await postFeedback(url, key, { prompts: [], ended: true });

    assert.equal(status, 200);
    assert.deepEqual(json, { queued: 0 });
    const session = store.get(key)!;
    assert.equal(session.status, "ended");
    assert.deepEqual(session.pending, [], "there is nothing for a poll to drain");
    // A "reviewer" turn with nothing under it would read as lost words; the ended status carries what happened.
    assert.deepEqual(session.conversation, []);
    assert.deepEqual(session.rounds.at(-1)?.approvedAtEnd, [], "the round is closed as it stood");
  });
});

test("ending the review through feedback is announced on the events stream", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const response = await fetch(`${url}/api/session/${key}/events`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    await postFeedback(url, key, {
      prompts: [{ type: "message", comment: "ship it" }],
      ended: true,
    });

    let seen = "";
    while (!seen.includes("event: session")) seen += decoder.decode((await reader.read()).value);
    await reader.cancel();
    assert.match(seen, /"reason":"ended"/);
  });
});

test("a prompt that is neither annotation nor message is a 400", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const { status } = await postFeedback(url, key, {
      prompts: [{ type: "annotation", comment: "missing the file" }],
      ended: false,
    });

    assert.equal(status, 400);
  });
});

test("feedback for an unknown session is a 404", async () => {
  await withServer(async ({ url }) => {
    const { status } = await postFeedback(url, "deadbeefdeadbeef", { prompts: [], ended: false });

    assert.equal(status, 404);
  });
});

test("an agent reply is appended to the conversation without queueing feedback", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: "wrapped it in a transaction" }),
    });

    assert.equal(response.status, 200);
    const session = store.get(key)!;
    assert.deepEqual(session.conversation.at(-1), {
      role: "agent",
      at: session.conversation.at(-1)!.at,
      // Stamped with the round open when said: lets the panel rule a line between rounds.
      roundIndex: 0,
      prompts: [{ type: "message", comment: "wrapped it in a transaction" }],
    });
    assert.deepEqual(session.pending, []);
  });
});

async function postReply(url: string, key: string, body: unknown): Promise<Response> {
  return await fetch(`${url}/api/session/${key}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a reply may declare what each comment led to, stored under the comment's id", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postFeedback(url, key, { prompts: [annotation], ended: false });
    const id = (store.get(key)!.pending[0] as { id: string }).id;

    const response = await postReply(url, key, {
      comment: "wrapped it in a transaction",
      declarations: [{ id, note: "one transaction now", files: ["src/api/users.ts"] }],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { delivered: true, declared: 1 });
    const declared = store.get(key)!.declarations?.[id];
    assert.partialDeepStrictEqual(declared, {
      note: "one transaction now",
      files: ["src/api/users.ts"],
    });
  });
});

test("a declaration for an id no comment carries rejects the whole reply", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postFeedback(url, key, { prompts: [annotation], ended: false });
    const before = store.get(key)!.conversation.length;

    const response = await postReply(url, key, {
      comment: "done",
      declarations: [{ id: "evt_ghost", note: "fixed", files: [] }],
    });

    assert.equal(response.status, 422);
    const body = (await response.json()) as { error: { code: string; detail: string } };
    assert.equal(body.error.code, "declaration_invalid");
    assert.match(body.error.detail, /evt_ghost/);
    // Rejected whole: the summary was not delivered and nothing was declared.
    const session = store.get(key)!;
    assert.equal(session.conversation.length, before);
    assert.equal(session.declarations, undefined);
  });
});

test("a reply whose declarations are not even the right shape is a 400", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    for (const declarations of ["evt_a", [{ note: "no id" }], [{ id: "evt_a", files: "a.ts" }]]) {
      const response = await postReply(url, key, { comment: "done", declarations });
      assert.equal(response.status, 400, JSON.stringify(declarations));
    }
  });
});

test("an agent reply without a comment is a 400", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
  });
});

/** The page's event stream, read one SSE frame at a time. */
interface OpenStream {
  /**
   * Next matching frame; earlier frames dropped, later ones kept. Frame-by-frame because the
   * server writes several frames in one tick and they arrive as one read.
   */
  until(wanted: RegExp): Promise<string>;
  close(): void;
}

async function openStream(url: string, key: string, budget = 5_000): Promise<OpenStream> {
  const abort = new AbortController();
  const response = await fetch(`${url}/api/session/${key}/events`, { signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let partial = "";

  /**
   * A frame that never comes aborts the read and fails the waiting test, never parking a run
   * forever. The budget is spent per read and refunded the moment one lands, because a test holds
   * one stream across several waits and does slow work between them — parking a poll, killing a
   * subprocess — and a budget spanning the whole stream fails that test on a loaded machine for
   * being slow rather than for being wrong.
   */
  async function readFrames(wanted: RegExp): Promise<void> {
    const deadline = setTimeout(() => abort.abort(), budget);
    try {
      const { done, value } = await reader.read();
      if (done) assert.fail(`the stream ended before it said ${wanted}`);
      const parts = (partial + decoder.decode(value)).split("\n\n");
      partial = parts.pop() ?? "";
      frames.push(...parts);
    } finally {
      clearTimeout(deadline);
    }
  }

  return {
    async until(wanted: RegExp): Promise<string> {
      for (;;) {
        const frame = frames.shift();
        if (frame === undefined) {
          await readFrames(wanted);
          continue;
        }
        if (wanted.test(frame)) return frame;
      }
    },
    close() {
      abort.abort();
    },
  };
}

/**
 * The bound on a poll this file parks and releases later. Everything the test does in between
 * happens inside it, so it catches a hang rather than measuring latency: wide enough that a
 * machine slow enough to be swapping never trips it, and finite so that a poll nothing releases
 * fails the test instead of running for as long as the suite is allowed to.
 */
const PARKED_POLL_LIMIT_MS = 30_000;

/**
 * A watch on this session's presence, on which `until(/"waiting":true/)` is a poll parking.
 * Awaiting that is how a test knows a poll is really waiting: the request is sent from here and
 * registered over there, so a test that paused a fixed moment instead was — on a machine busy
 * enough — sending the reviewer's word to a poll the server had never heard of, and passing down
 * the path where the answer was already there, with none of the waiting it is named for.
 *
 * Opened before the polls it is asked about, and primed by dropping the frame every new watcher
 * is handed: that one states what was true beforehand, and presence carries a flag rather than a
 * count, so the frames are all that tells one park from the next. Each wait is bounded by the
 * stream's read budget, so a park that never comes fails the test instead of hanging the run.
 */
async function parkWatch(url: string, key: string): Promise<OpenStream> {
  const stream = await openStream(url, key);
  await stream.until(/event: presence/);
  return stream;
}

test("ending a session closes it and releases a waiting poll", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    const parks = await parkWatch(url, key);
    // Bounded too: an `end` that leaves the poll parked must fail this test, not hang the run.
    const polling = fetch(`${url}/api/poll?key=${key}`, {
      signal: AbortSignal.timeout(PARKED_POLL_LIMIT_MS),
    });
    await parks.until(/"waiting":true/);
    parks.close();

    const response = await fetch(`${url}/api/session/${key}/end`, { method: "POST" });

    assert.equal(response.status, 200);
    assert.equal(store.get(key)?.status, "ended");
    assert.equal(store.get(key)?.endedBy, "agent");
    assert.deepEqual(await (await polling).json(), {
      status: "ended",
      ended: true,
      prompts: [],
      approval: { verdict: "none", approved: 0, unapproved: 1, swept: 0, total: 1 },
      endedBy: "agent",
    });
  });
});

test("an agent's `end` after the reviewer already ended does not take the credit", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);
    await postFeedback(url, key, { prompts: [], ended: true });

    const response = await fetch(`${url}/api/session/${key}/end`, { method: "POST" });

    // `end` stays idempotent (200), but the second close decided nothing: reporting the agent
    // would contradict the approvals sent with it.
    assert.equal(response.status, 200);
    assert.equal(store.get(key)?.endedBy, "reviewer");
    assert.deepEqual(await (await fetch(`${url}/api/poll?key=${key}`)).json(), {
      status: "ended",
      ended: true,
      prompts: [],
      approval: { verdict: "signed-off", approved: 1, unapproved: 0, swept: 0, total: 1 },
      endedBy: "reviewer",
    });
  });
});

test("a stale tab ending a session an agent already ended does not become the closer", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await fetch(`${url}/api/session/${key}/end`, { method: "POST" });

    const posted = await postFeedback(url, key, { prompts: [], ended: true });

    assert.equal(posted.status, 200);
    assert.equal(store.get(key)?.endedBy, "agent");
    assert.deepEqual(await (await fetch(`${url}/api/poll?key=${key}`)).json(), {
      status: "ended",
      ended: true,
      prompts: [],
      approval: { verdict: "none", approved: 0, unapproved: 1, swept: 0, total: 1 },
      endedBy: "agent",
    });
  });
});

test("ending an unknown session is a 404", async () => {
  await withServer(async ({ url }) => {
    assert.equal(
      (await fetch(`${url}/api/session/deadbeefdeadbeef/end`, { method: "POST" })).status,
      404,
    );
  });
});

test("a poll with feedback already queued returns it at once and drains the queue", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postFeedback(url, key, { prompts: [annotation], ended: false });

    const polled = (await (await fetch(`${url}/api/poll?key=${key}`)).json()) as {
      status: string;
      ended: boolean;
      prompts: unknown[];
    };

    assert.partialDeepStrictEqual(polled, {
      status: "feedback",
      ended: false,
      prompts: [annotation],
    });
    assert.deepEqual(store.get(key)?.pending, []);
  });
});

test("a poll after a silent ending is told the review is over, and nothing more", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    await postFeedback(url, key, { prompts: [], ended: true });

    const polled = await (await fetch(`${url}/api/poll?key=${key}`)).json();

    // A silent ending with nothing ticked must not reach the agent looking like a sign-off.
    assert.deepEqual(polled, {
      status: "ended",
      ended: true,
      prompts: [],
      approval: { verdict: "none", approved: 0, unapproved: 1, swept: 0, total: 1 },
      endedBy: "reviewer",
    });
  });
});

test("a silent ending after the reviewer ticked every file says so on the wire", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);
    await postFeedback(url, key, { prompts: [], ended: true });

    const polled = await (await fetch(`${url}/api/poll?key=${key}`)).json();

    assert.deepEqual(polled, {
      status: "ended",
      ended: true,
      prompts: [],
      approval: { verdict: "signed-off", approved: 1, unapproved: 0, swept: 0, total: 1 },
      endedBy: "reviewer",
    });
  });
});

test("a part-line selection reaches the agent with the characters it marked", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const clipped = {
      ...annotation,
      selected_text: "fetchUser(id)",
      side: "new",
      line_start: 12,
      line_end: 12,
      col_start: 14,
      col_end: 26,
    };

    await postFeedback(url, key, { prompts: [clipped], ended: false });

    const polled = (await (await fetch(`${url}/api/poll?key=${key}`)).json()) as {
      prompts: unknown[];
    };
    assert.partialDeepStrictEqual(polled.prompts, [clipped]);
  });
});

test("a poll waits for feedback that arrives later", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const parks = await parkWatch(url, key);
    // Bounded: feedback that never reaches the parked poll fails the test instead of hanging it.
    const polling = fetch(`${url}/api/poll?key=${key}`, {
      signal: AbortSignal.timeout(PARKED_POLL_LIMIT_MS),
    });
    await parks.until(/"waiting":true/);
    parks.close();

    await postFeedback(url, key, { prompts: [annotation], ended: true });

    const polled = (await (await polling).json()) as { ended: boolean; prompts: unknown[] };
    assert.equal(polled.ended, true);
    assert.partialDeepStrictEqual(polled.prompts, [annotation]);
  });
});

/**
 * A poll parked on a connection the test can kill without telling the server, as a dying agent
 * connection does. `parked` is how the caller knows the server has it and there is no default:
 * a test that killed after a fixed pause was killing a poll the server had never heard of
 * whenever the machine was busy enough. See `parkWatch` for what such a caller waits on.
 */
async function parkedPoll(
  url: string,
  key: string,
  parked: () => Promise<unknown>,
): Promise<{ kill: () => void }> {
  const target = new URL(`${url}/api/poll?key=${key}`);
  const request = httpRequest({
    host: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    agent: false,
  });
  // Killing the request is the point of it: the hang-up is expected, not a fault.
  request.on("error", () => undefined);
  request.end();
  await parked();
  return { kill: () => request.destroy() };
}

test("feedback drained for a poll whose connection died is still there for the next one", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    // Both orders of the race: connection dies before the reviewer sends, and while the answer is written.
    for (const killFirst of [true, false]) {
      // A watch of its own each pass, and never one shared across both: `until` keeps the frames
      // it walked past, so a `"waiting":true` left over from the pass before would confirm this
      // pass's park without it having happened. Closed as soon as it has answered, so the race
      // below runs against the same two connections it always did.
      const watch = await parkWatch(url, key);
      const poll = await parkedPoll(url, key, () => watch.until(/"waiting":true/));
      watch.close();
      if (killFirst) poll.kill();
      const posting = postFeedback(url, key, { prompts: [annotation], ended: false });
      if (!killFirst) poll.kill();
      await posting;

      // Bounded so feedback lost into the dead connection fails the test instead of parking forever.
      const answer = await fetch(`${url}/api/poll?key=${key}`, {
        signal: AbortSignal.timeout(2_000),
      });
      const polled = (await answer.json()) as { prompts: unknown[] };
      assert.partialDeepStrictEqual(polled.prompts, [annotation], `killFirst: ${killFirst}`);
      assert.deepEqual(store.get(key)?.pending, []);
    }
  });
});

test("a second poller keeps waiting instead of getting an empty answer", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    // One at a time, each parked before the next is fired: the feedback goes to whoever parked
    // first, so which of the two that is has to be settled rather than raced.
    const parks = await parkWatch(url, key);
    const poll = () =>
      fetch(`${url}/api/poll?key=${key}`, { signal: AbortSignal.timeout(PARKED_POLL_LIMIT_MS) });
    const first = poll();
    await parks.until(/"waiting":true/);
    const second = poll();
    await parks.until(/"waiting":true/);
    parks.close();

    await postFeedback(url, key, { prompts: [annotation], ended: false });

    const drained = (await (await first).json()) as { prompts: unknown[] };
    assert.partialDeepStrictEqual(drained.prompts, [annotation]);

    // The queue is empty now, so the second poller must still be waiting.
    await postFeedback(url, key, {
      prompts: [{ type: "message", comment: "and one more thing" }],
      ended: false,
    });
    const later = (await (await second).json()) as { prompts: unknown[] };
    assert.deepEqual(later.prompts, [{ type: "message", comment: "and one more thing" }]);
  });
});

test("polling an ended session returns at once instead of blocking forever", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    store.save({ ...store.get(key)!, status: "ended" });

    const polled = (await (await fetch(`${url}/api/poll?key=${key}`)).json()) as {
      ended: boolean;
      prompts: unknown[];
    };

    // Ended in the store without either route — how a session written before `endedBy` reads.
    assert.deepEqual(polled, {
      status: "ended",
      ended: true,
      prompts: [],
      approval: { verdict: "none", approved: 0, unapproved: 1, swept: 0, total: 1 },
    });
  });
});

test("polling an unknown session is a 404", async () => {
  await withServer(async ({ url }) => {
    assert.equal((await fetch(`${url}/api/poll?key=deadbeefdeadbeef`)).status, 404);
  });
});

test("an unknown route is a 404", async () => {
  await withServer(async ({ url }) => {
    assert.equal((await fetch(`${url}/nope`)).status, 404);
  });
});

test("a foreign Host header is rejected to block DNS rebinding", async () => {
  await withServer(async ({ url }) => {
    // fetch() refuses to set Host, so this one goes through node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${url}/health`,
        { headers: { host: "evil.example.com" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });

    assert.equal(status, 403);
  });
});

test("the events stream opens as SSE and pushes an update when the session changes", async () => {
  await withServer(async ({ url, server }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/events`);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /^: connected\n\n/);

    server.publish(key, "session", { reason: "updated" });
    const chunk = decoder.decode((await reader.read()).value);
    await reader.cancel();

    assert.match(chunk, /event: session/);
    assert.match(chunk, /"reason":"updated"/);
  });
});

test("a browser opening the stream is told straight away whether an agent is waiting", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/events`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    await reader.cancel();

    assert.match(first, /event: presence/);
    assert.match(first, /"waiting":false/);
  });
});

test("presence flips while an agent polls and back when it gives up", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const response = await fetch(`${url}/api/session/${key}/events`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();

    const abort = new AbortController();
    const polling = fetch(`${url}/api/poll?key=${key}`, { signal: abort.signal });
    const waiting = decoder.decode((await reader.read()).value);
    abort.abort();
    await polling.catch(() => undefined);
    const gone = decoder.decode((await reader.read()).value);
    await reader.cancel();

    assert.match(waiting, /event: presence[\s\S]*"waiting":true/);
    assert.match(gone, /event: presence[\s\S]*"waiting":false/);
  });
});

test("a stream survives a test that is slow between the frames it waits for", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    // A budget smaller than the pause below: with one deadline for the whole stream this stream is
    // already aborted by the time the second frame is asked for, which is the CI failure in the
    // small. Spent per read, the pause costs nothing, because no read is outstanding during it.
    const stream = await openStream(url, key, 200);
    await stream.until(/event: presence/);

    await setTimeoutPromise(400);

    const parked = new AbortController();
    void fetch(`${url}/api/poll?key=${key}`, { signal: parked.signal }).catch(() => undefined);
    assert.match(await stream.until(/event: presence/), /"waiting":true/);
    parked.abort();
    stream.close();
  });
});

test("presence says an agent is working once a poll has carried the feedback off", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const stream = await openStream(url, key);
    await stream.until(/event: presence/);
    await postFeedback(url, key, { prompts: [annotation], ended: false });

    await fetch(`${url}/api/poll?key=${key}`, { signal: AbortSignal.timeout(2_000) });

    assert.match(await stream.until(/event: presence/), /"waiting":false,"working":true/);
    stream.close();
  });
});

test("a poll that parks announces the agent arriving, and says so once", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const stream = await openStream(url, key);
    await stream.until(/event: presence/);

    const parked = new AbortController();
    void fetch(`${url}/api/poll?key=${key}`, { signal: parked.signal }).catch(() => undefined);

    // The very next frame, not the one after: parking clears the working flag and registers the
    // poller; if the clear goes out first, the page briefly says nobody waits just as somebody arrived.
    assert.match(await stream.until(/event: presence/), /"waiting":true/);
    parked.abort();
    stream.close();
  });
});

test("an agent asking for more feedback is an agent that is no longer working", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const stream = await openStream(url, key);
    await stream.until(/event: presence/);
    await postFeedback(url, key, { prompts: [annotation], ended: false });
    await fetch(`${url}/api/poll?key=${key}`, { signal: AbortSignal.timeout(2_000) });
    await stream.until(/"working":true/);

    // An agent that skips the reply and polls again has finished with what it took;
    // parking for the next feedback is it saying so.
    const parked = new AbortController();
    void fetch(`${url}/api/poll?key=${key}`, { signal: parked.signal }).catch(() => undefined);

    assert.match(await stream.until(/"waiting":true/), /"working":false/);
    parked.abort();
    stream.close();
  });
});

test("the agent answering says the work on that feedback is over", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const stream = await openStream(url, key);
    await stream.until(/event: presence/);
    await postFeedback(url, key, { prompts: [annotation], ended: false });
    await fetch(`${url}/api/poll?key=${key}`, { signal: AbortSignal.timeout(2_000) });
    await stream.until(/"working":true/);

    assert.equal(
      (await postReply(url, key, { comment: "wrapped it in a transaction" })).status,
      200,
    );

    assert.match(await stream.until(/event: presence/), /"working":false/);
    stream.close();
  });
});

test("a round opened on what the agent did leaves nobody working", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const stream = await openStream(url, key);
    await stream.until(/event: presence/);
    await postFeedback(url, key, { prompts: [annotation], ended: false });
    await fetch(`${url}/api/poll?key=${key}`, { signal: AbortSignal.timeout(2_000) });
    await stream.until(/"working":true/);

    await postSession(url);

    assert.match(await stream.until(/event: presence/), /"working":false/);
    stream.close();
  });
});

test("a review that ends leaves nobody working, whoever ended it", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const stream = await openStream(url, key);
    await stream.until(/event: presence/);
    await postFeedback(url, key, { prompts: [annotation], ended: false });
    await fetch(`${url}/api/poll?key=${key}`, { signal: AbortSignal.timeout(2_000) });
    await stream.until(/"working":true/);

    await fetch(`${url}/api/session/${key}/end`, { method: "POST" });

    assert.match(await stream.until(/event: presence/), /"working":false/);
    stream.close();
  });
});

test("a poll that died holding the feedback leaves the agent reading as working", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    // Watched on one stream of this test's own: the wait below matches `event: presence` loosely,
    // so a frame published for a second watcher's benefit could answer it.
    const stream = await parkWatch(url, key);
    const poll = await parkedPoll(url, key, () => stream.until(/"waiting":true/));

    // The handover first and awaited, so the work is the agent's before its connection dies. Which
    // of the two happened first decides what the server can say afterwards, and a test that posted
    // and killed in the same breath was letting the machine's mood pick the scenario.
    await postFeedback(url, key, { prompts: [annotation], ended: false });
    await stream.until(/"working":true/);

    poll.kill();

    // The frame the death itself publishes: the waiter is gone, the work is not. A dead agent
    // reads exactly like one thinking hard and there is no heartbeat to tell them apart, so the
    // flag stands until the next poll, reply, round or end clears it — clearing it here would
    // announce that nobody is acting on feedback that has already left the building.
    assert.match(await stream.until(/event: presence/), /"waiting":false,"working":true/);
    stream.close();
  });
});

test("a poll carrying the reviewer's last word marks nobody working", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    await postFeedback(url, key, { prompts: [annotation], ended: true });

    await fetch(`${url}/api/poll?key=${key}`, { signal: AbortSignal.timeout(2_000) });

    // Stream opened after the poll: its first frame is the state as it stands.
    const stream = await openStream(url, key);
    assert.match(await stream.until(/event: presence/), /"working":false/);
    stream.close();
  });
});

test("a page on another origin cannot drive the review API", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ prompts: [annotation], ended: false }),
    });

    assert.equal(response.status, 403);
    assert.deepEqual(store.get(key)?.pending, []);
  });
});

test("the review page's own origin is accepted", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ prompts: [annotation], ended: false }),
    });

    assert.equal(response.status, 200);
  });
});

test("posting to shutdown answers first and then stops listening", async () => {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-shutdown-")));
  const server = createReviewServer({ store, port: 0 });
  const { url } = await server.start();

  const response = await fetch(`${url}/api/shutdown`, { method: "POST" });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "stopping" });
  await assert.rejects(() => fetch(`${url}/health`));
  await server.stop();
});

test("whenStopped resolves once the server stops, so a foreground `serve` can exit", async () => {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-stopped-")));
  const server = createReviewServer({ store, port: 0 });
  await server.start();
  let resolved = false;
  const stopped = server.whenStopped().then(() => (resolved = true));

  assert.equal(resolved, false);
  await server.stop();
  await stopped;

  assert.equal(resolved, true);
});

test("a malformed session payload is a 400, not a 500", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "feature-auth" }),
    });

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /invalid_request/);
  });
});

test("posting approved files persists them on the session", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/approved`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: ["src/api/users.ts"] }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { approved: ["src/api/users.ts"] });
    assert.deepEqual(store.get(key)?.approved, ["src/api/users.ts"]);
  });
});

test("approved paths that are not part of the session are dropped", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/approved`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: ["src/api/users.ts", "../../etc/passwd"] }),
    });

    assert.deepEqual(await response.json(), { approved: ["src/api/users.ts"] });
    assert.deepEqual(store.get(key)?.approved, ["src/api/users.ts"]);
  });
});

test("an approved payload that is not a list of paths is a 400", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const response = await fetch(`${url}/api/session/${key}/approved`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: [1, 2] }),
    });

    assert.equal(response.status, 400);
  });
});

test("posting approved files for an unknown session is a 404", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/session/deadbeefdeadbeef/approved`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: [] }),
    });

    assert.equal(response.status, 404);
  });
});

/** A bundle directory holding the two files a review page cannot mount without. */
function bundleDir(script = "console.log('hi');", style = ".lsr-file{}"): string {
  const staticDir = mkdtempSync(join(tmpdir(), "lsr-static-"));
  writeFileSync(join(staticDir, "app.js"), script);
  writeFileSync(join(staticDir, "app.css"), style);
  return staticDir;
}

test("static assets are served from the build output directory", async () => {
  const staticDir = bundleDir();

  await withServer(
    async ({ url }) => {
      const script = await fetch(`${url}/static/app.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get("content-type") ?? "", /javascript/);
      assert.match(await script.text(), /console.log/);

      const style = await fetch(`${url}/static/app.css`);
      assert.match(style.headers.get("content-type") ?? "", /text\/css/);
    },
    { staticDir },
  );
});

/**
 * Drift this closes: a rebuild under a running server used to pair an old shell with new CSS.
 * The server serves the build it started with until a new round opens.
 */
test("a rebuild under a running server does not change what it serves", async () => {
  const staticDir = bundleDir("console.log('first');", ".lsr-review{overflow:auto}");

  await withServer(
    async ({ url }) => {
      assert.match(await (await fetch(`${url}/static/app.css`)).text(), /overflow:auto/);

      writeFileSync(join(staticDir, "app.css"), ".lsr-nothing{display:none}");
      writeFileSync(join(staticDir, "app.js"), "console.log('second');");

      assert.equal(
        await (await fetch(`${url}/static/app.css`)).text(),
        ".lsr-review{overflow:auto}",
      );
      assert.equal(await (await fetch(`${url}/static/app.js`)).text(), "console.log('first');");
    },
    { staticDir },
  );
});

/**
 * A new round is the one moment page and build must re-align: the agent
 * typically rebuilt the CLI before reopening, and the reviewer reloads anyway.
 */
test("opening a round re-snapshots the bundle, so a rebuilt asset serves fresh", async () => {
  const staticDir = bundleDir("console.log('first');");

  await withServer(
    async ({ url }) => {
      writeFileSync(join(staticDir, "app.js"), "console.log('second');");
      assert.match(await (await fetch(`${url}/static/app.js`)).text(), /first/);

      await postSession(url);

      assert.equal(await (await fetch(`${url}/static/app.js`)).text(), "console.log('second');");
    },
    { staticDir },
  );
});

test("a bundle broken at round start keeps the old snapshot; the round still opens", async () => {
  const staticDir = bundleDir("console.log('first');");

  await withServer(
    async ({ url }) => {
      rmSync(join(staticDir, "app.js"));

      const created = await postSession(url);
      assert.ok(created.key, "the round opened despite the broken build");

      const script = await fetch(`${url}/static/app.js`);
      assert.equal(script.status, 200);
      assert.match(await script.text(), /first/, "the old snapshot still serves whole");
    },
    { staticDir },
  );
});

/** An asset added after start is not served either: the snapshot is the build. */
test("an asset the bundle did not have at start is a 404", async () => {
  const staticDir = bundleDir();

  await withServer(
    async ({ url }) => {
      writeFileSync(join(staticDir, "late.js"), "console.log('late');");
      const response = await fetch(`${url}/static/late.js`);

      assert.equal(response.status, 404);
      assert.match(JSON.stringify(await response.json()), /pnpm run build/);
    },
    { staticDir },
  );
});

test("a server whose browser bundle is missing refuses to start", () => {
  const staticDir = mkdtempSync(join(tmpdir(), "lsr-static-"));
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-server-")));

  assert.throws(
    () => createReviewServer({ store, port: 0, staticDir }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "browser_bundle_missing" &&
      /pnpm run build/.test(error.message),
  );
});

test("a static path cannot escape the bundle directory", async () => {
  const staticDir = bundleDir();

  await withServer(
    async ({ url }) => {
      const response = await fetch(`${url}/static/..%2f..%2fetc%2fpasswd`);

      assert.equal(response.status, 404);
    },
    { staticDir },
  );
});

test("a body that is not JSON is a 400", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });

    assert.equal(response.status, 400);
  });
});
