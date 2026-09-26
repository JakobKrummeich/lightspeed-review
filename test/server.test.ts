import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import { CLI_VERSION } from "../src/version.ts";
import { SessionStore } from "../src/session-store.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import type { AnnotationRecord } from "../src/ledger/records.ts";
import { createReviewServer } from "../src/server.ts";
import { ReviewError } from "../src/errors.ts";
import { MAX_APPROVED_FORM_BYTES } from "../src/rounds/approved-form.ts";
import { sessionKey } from "../src/paths.ts";
import { git, newRepo } from "./helpers/git-repo.ts";
import {
  annotation,
  openStream,
  postFeedback,
  postSession,
  postSessionRaw,
  pollOnce,
  publishRound,
  sessionPayload,
  withServer,
  type RunningServer,
  type ServerOptions,
} from "./helpers/review-server.ts";

/** The same file, edited again by the agent: a new new-side blob sha. */
function editedPayload(index: string): Record<string, unknown> {
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

async function endedSession(url: string, store: SessionStore): Promise<string> {
  const { key } = await postSession(url);
  await fetch(`${url}/api/session/${key}/end`, { method: "POST" });
  assert.equal(store.get(key)?.status, "ended");
  return key;
}

test("a round posted to an ended review is refused, naming who ended it, and changes nothing", async () => {
  await withServer(async ({ url, store }) => {
    const key = await endedSession(url, store);
    const before = store.get(key)!;

    const response = await postSessionRaw(url, sessionPayload);

    assert.equal(response.status, 409);
    // Ended through `/end`, the agent's move: the reviewer did not end it.
    assert.deepEqual(await response.json(), {
      error: {
        code: "session_ended",
        message:
          "`lightspeed end` ended this review, not the reviewer; a new round is still the reviewer's call",
      },
      endedBy: "agent",
    });
    assert.deepEqual(store.get(key), before);
  });
});

/**
 * Bodies outside the three modes are dropped rather than stored; absent reads as `llm`,
 * which is what every round written before the field does.
 */
test("a round records how its grouping was arrived at, and only if it is a real mode", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const { key } = await postSession(url);
    assert.equal(store.get(key)?.rounds.at(-1)?.grouping, undefined);

    await publishRound(running, { ...sessionPayload, grouping: "fallback" });
    await publishRound(running, { ...sessionPayload, grouping: "banana" });

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

/**
 * A `serve` from weeks earlier was still answering the current CLI with a
 * pre-turn protocol; the version is the whole of what a handshake needs.
 */
test("health reports ok and the version of the CLI that started it", async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(`${url}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", version: CLI_VERSION });
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

test("opening the same branch pair twice re-attaches instead of opening a round", async () => {
  await withServer(async ({ url, store }) => {
    const first = await postSession(url);
    const response = await postSessionRaw(url, sessionPayload);

    assert.equal(response.status, 200);
    const second = (await response.json()) as { key: string; reattached?: boolean };
    assert.equal(first.key, second.key);
    assert.equal(second.reattached, true);
    assert.equal(store.list().length, 1);
    assert.equal(store.get(first.key)?.rounds.length, 1);
  });
});

test("re-posting a session preserves the conversation and the approvals it can vouch for", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const { key } = await postSession(url);
    const stored = store.get(key)!;
    store.save({
      ...stored,
      approved: ["src/api/users.ts"],
      conversation: [{ role: "reviewer", at: "2025-01-01T00:00:00.000Z", prompts: [] }],
    });

    await publishRound(running);

    const updated = store.get(key)!;
    // File unmoved since the tick, so the reviewer is not asked to read it again.
    assert.deepEqual(updated.approved, ["src/api/users.ts"]);
    assert.equal(updated.conversation.length, 1);
  });
});

test("an approval sent to the agent without ending the round survives the next start", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);
    await fetch(`${url}/api/session/${key}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompts: [{ type: "message", comment: "one more pass" }] }),
    });

    await publishRound(running);

    const session = store.get(key)!;
    assert.deepEqual(session.approved, ["src/api/users.ts"]);
    assert.deepEqual(
      session.rounds.map((round) => round.approvedAtEnd),
      [["src/api/users.ts"], []],
    );
  });
});

test("un-ticking a carried approval sticks, in the answer now and in the next round", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);
    await publishRound(running);
    assert.deepEqual(store.get(key)?.approved, ["src/api/users.ts"]);

    await postApproved(url, key, []);

    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      approval: Record<string, string>;
    };
    assert.deepEqual(data.approval, { "src/api/users.ts": "unapproved" });
    await publishRound(running);
    assert.deepEqual(store.get(key)?.approved, []);
  });
});

test("every round but the one being reviewed has been closed on what was ticked", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);
    await publishRound(running);
    await publishRound(running);

    const rounds = store.get(key)!.rounds;
    assert.equal(rounds.length, 3);
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
  await withServer(async (running) => {
    const { url, store } = running;
    const { key } = await postSession(url);
    await postApproved(url, key, ["src/api/users.ts"]);

    await publishRound(running, editedPayload("index 4c9f88d..7d5e213 100644"));

    assert.deepEqual(store.get(key)?.approved, []);
    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      approval: Record<string, string>;
    };
    assert.deepEqual(data.approval, { "src/api/users.ts": "needs-reapproval" });
  });
});

test("an approved deletion is carried into the next round", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
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

    await publishRound(running, deletion);

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
  await withServer(async (running) => {
    const { url, store } = running;
    const { key } = await postSession(url);
    const first = store.get(key)!;
    store.save({
      ...first,
      approved: ["src/api/users.ts"],
      rounds: [{ ...first.rounds[0]!, approvedAtEnd: ["src/api/users.ts"] }],
    });
    await publishRound(running);

    const data = (await (await fetch(`${url}/api/session/${key}/data`)).json()) as {
      approval: Record<string, string>;
    };

    assert.deepEqual(data.approval, { "src/api/users.ts": "approved" });
  });
});

test("the data endpoint calls a file nobody approved unapproved on its second round", async () => {
  await withServer(async (running) => {
    const { url } = running;
    const { key } = await postSession(url);
    await publishRound(running);

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
    await publishRound(running, usersRound(repoRoot, baseCommit!, head!));
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

  await withServer(async (running) => {
    const { url } = running;
    const { key } = (await (
      await postSessionRaw(url, usersRound(repoRoot, baseCommit!, approvedAt!))
    ).json()) as { key: string };
    await postApproved(url, key, [USERS]);
    await publishRound(running, usersRound(repoRoot, baseCommit!, changed!));
    await publishRound(running, usersRound(repoRoot, baseCommit!, head!));

    const data = (await (await approvedForm(url, key, USERS)).json()) as {
      state: string;
      diff?: string;
    };

    assert.equal(data.state, "identical");
    assert.equal(data.diff, undefined);
  });
});

test("a file that has become binary is named as that, not served as an empty diff", async () => {
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
  await withServer(async (running) => {
    const { url, store } = running;
    const { key } = await postSession(url);
    await postApproved(url, key, [USERS]);
    await publishRound(running, editedPayload("index 4c9f88d..7d5e213 100644"));
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
  const repoRoot = reapprovalRepo("lsr-unmoved-", {
    "Take the users handler off the old constant": "const fresh = 2;\n",
  });
  const [baseCommit, head] = commitLine(repoRoot, 2);
  // A round only opens on a HEAD that moved, so the next one moves it elsewhere.
  writeFileSync(join(repoRoot, "secret.env"), "TOKEN=2\n");
  git(repoRoot, "commit", "-am", "Rotate the token");
  const [elsewhere] = commitLine(repoRoot, 1);

  await withServer(async (running) => {
    const { url } = running;
    const { key } = (await (
      await postSessionRaw(url, usersRound(repoRoot, baseCommit!, head!))
    ).json()) as { key: string };
    await publishRound(running, usersRound(repoRoot, baseCommit!, elsewhere!));

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

test("ending an unknown session is a 404", async () => {
  await withServer(async ({ url }) => {
    assert.equal(
      (await fetch(`${url}/api/session/deadbeefdeadbeef/end`, { method: "POST" })).status,
      404,
    );
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
    // A budget smaller than the pause below: one deadline for the whole stream would have aborted
    // it before the second frame is asked for. Spent per read, the pause costs nothing.
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

/**
 * The gate is global — one check in front of the router, not a decoration each
 * route remembers to wear. `/delivered` is here because it mutates: a page that
 * could confirm a handover could make the review forget feedback nobody read.
 */
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

    await postFeedback(url, key, { prompts: [annotation], ended: false });
    const inFlight = await pollOnce(url, key);
    const forged = await fetch(`${url}/api/session/${key}/delivered`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ delivery: inFlight.delivery }),
    });

    assert.equal(forged.status, 403);
    assert.equal(store.get(key)?.batch?.id, inFlight.delivery);
    assert.equal(store.get(key)?.batch?.acked, false);
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

/** Regression: a rebuild under a running server paired an old shell with new CSS. */
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
