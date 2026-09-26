import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectItems } from "../src/ledger/export.ts";
import { sessionsDirPath } from "../src/paths.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import type { LedgerRecord, OutcomeRecord } from "../src/ledger/records.ts";
import { git, newRepo } from "./helpers/git-repo.ts";
import { SessionStore } from "../src/session-store.ts";
import { createReviewServer, type ReviewServer } from "../src/server.ts";
import { agentWorking } from "../src/turn.ts";
import { pollAndAck } from "./helpers/review-server.ts";

interface Running {
  url: string;
  store: SessionStore;
  /** Where the sessions live, so a test can delete them out from under the ledger. */
  stateDir: string;
  ledger: LedgerStore | undefined;
  server: ReviewServer;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lsr-server-ledger-"));
}

/** `undefined` stands for `feedbackLog: "off"`; a blocked path for a broken disk. */
function ledgerOf(kind: "on" | "off" | "broken"): LedgerStore | undefined {
  if (kind === "off") return undefined;
  if (kind === "on") return new LedgerStore(join(tempDir(), "feedback"));
  const blocker = join(tempDir(), "blocker");
  writeFileSync(blocker, "not a directory");
  return new LedgerStore(join(blocker, "feedback"));
}

async function withServer(
  kind: "on" | "off" | "broken",
  body: (running: Running) => Promise<void>,
): Promise<void> {
  const stateDir = tempDir();
  const store = new SessionStore(stateDir);
  const ledger = ledgerOf(kind);
  const server = createReviewServer({ store, ledger, port: 0 });
  const { url } = await server.start();
  try {
    await body({ url, store, stateDir, ledger, server });
  } finally {
    await server.stop();
  }
}

const sessionPayload = {
  repoRoot: "/repo",
  branch: "feature-auth",
  base: "main",
  baseCommit: "aaa1111",
  headCommit: "bbb2222",
  groups: [
    {
      name: "API Handlers",
      rationale: "request handling",
      files: [
        {
          path: "src/api/users.ts",
          status: "modified",
          diff: "index 1111aaa..2222bbb 100644\n@@ -1 +1 @@\n-old\n+new",
          insertions: 1,
          deletions: 1,
          oversized: false,
        },
        {
          path: "logo.png",
          status: "binary",
          diff: "",
          insertions: 0,
          deletions: 0,
          oversized: false,
        },
      ],
    },
  ],
};

interface Created {
  key: string;
  ledger: { status: string; path?: string; reason?: string };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startRound(url: string, payload: unknown = sessionPayload): Promise<Created> {
  const response = await postJson(`${url}/api/sessions`, payload);
  assert.equal(response.status, 200);
  return (await response.json()) as Created;
}

async function reopenRound(
  url: string,
  payload: Record<string, unknown> = sessionPayload,
): Promise<Created> {
  return await startRound(url, { ...payload, reopen: true });
}

/**
 * The next round the way 3.0 opens one: a publish from a working turn on a
 * HEAD that moved. The turn is written straight onto the record — these tests
 * are about the ledger, not about how the turn got there.
 */
async function publishNext(
  url: string,
  store: SessionStore,
  key: string,
  payload: Record<string, unknown> = { ...sessionPayload, headCommit: "ccc3333" },
): Promise<Response> {
  store.save({ ...store.get(key)!, turn: agentWorking(new Date().toISOString(), "fixes") });
  return await postJson(`${url}/api/sessions`, { ...payload, verb: "publish" });
}

/** Two commits of one file, so a second round has a real diff to point at. */
function repoWithTwoCommits(): { repoRoot: string; first: string; second: string } {
  const repoRoot = newRepo("lsr-outcomes-");
  writeFileSync(join(repoRoot, "users.ts"), "const a = 1;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "first");
  const first = git(repoRoot, "rev-parse", "HEAD");
  writeFileSync(join(repoRoot, "users.ts"), "const a = 2;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "second");
  return { repoRoot, first, second: git(repoRoot, "rev-parse", "HEAD") };
}

function roundPayload(repoRoot: string, headCommit: string, blob: string): Record<string, unknown> {
  return {
    ...sessionPayload,
    repoRoot,
    headCommit,
    groups: [
      {
        name: "API Handlers",
        rationale: "request handling",
        files: [
          {
            path: "users.ts",
            status: "modified",
            diff: `index 1111aaa..${blob} 100644\n@@ -1 +1 @@\n-old\n+new`,
            insertions: 1,
            deletions: 1,
            oversized: false,
          },
        ],
      },
    ],
  };
}

function outcomes(ledger: LedgerStore | undefined): OutcomeRecord[] {
  return (ledger?.read({}).records ?? []).filter((record) => record.kind === "outcome");
}

test("the next round judges the previous round's annotations against the new commit", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { repoRoot, first, second } = repoWithTwoCommits();
    const { key } = await startRound(url, roundPayload(repoRoot, first, "2222bbb"));
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [
        {
          type: "annotation",
          file: "users.ts",
          group: "API Handlers",
          selected_text: "+new",
          comment: "use a constant",
        },
      ],
      ended: true,
    });

    await reopenRound(url, roundPayload(repoRoot, second, "3333ccc"));

    const annotation = (ledger?.read({}).records ?? []).find(
      (record) => record.kind === "annotation",
    );
    assert.equal(outcomes(ledger).length, 1);
    assert.partialDeepStrictEqual(outcomes(ledger)[0], {
      about: annotation?.id,
      from_commit: first,
      to_commit: second,
      file_touched: true,
      re_annotated: false,
      verdict: "addressed",
    });
    assert.match(outcomes(ledger)[0]?.response_patch ?? "", /-const a = 1;/);
  });
});

test("deleting every session file loses nothing from the ledger", async () => {
  await withServer("on", async ({ url, stateDir, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [
        {
          type: "annotation",
          file: "src/api/users.ts",
          group: "API Handlers",
          selected_text: "+new",
          comment: "Return a ReviewError",
        },
      ],
      ended: true,
    });
    const before = ledger?.read({}).records ?? [];

    rmSync(sessionsDirPath(stateDir), { recursive: true, force: true });

    assert.deepEqual(ledger?.read({}).records, before);
    assert.partialDeepStrictEqual(selectItems(before, {}).items[0], {
      file: "src/api/users.ts",
      comment: "Return a ReviewError",
    });
  });
});

test("an item stays readable after the repository it came from is deleted", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { repoRoot, first } = repoWithTwoCommits();
    const { key } = await startRound(url, roundPayload(repoRoot, first, "2222bbb"));
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [
        {
          type: "annotation",
          file: "users.ts",
          group: "API Handlers",
          side: "new",
          line_start: 1,
          line_end: 1,
          selected_text: "const a = 1;",
          comment: "use a constant",
        },
      ],
      ended: true,
    });

    rmSync(repoRoot, { recursive: true, force: true });

    const item = selectItems(ledger?.read({}).records ?? [], {}).items[0];
    assert.partialDeepStrictEqual(item, {
      repo: { root: repoRoot },
      file: "users.ts",
      head_commit: first,
      selected_text: "const a = 1;",
      comment: "use a constant",
      context_source: "anchor",
    });
    assert.match(item?.context ?? "", /const a = 1;/);
  });
});

/**
 * A thread id (`t1`) is unique within its session only, and ledger ids span
 * every session the ledger holds: the two are different names on purpose.
 */
test("a queued annotation gets a thread id; its ledger record keeps a ledger-wide one", async () => {
  await withServer("on", async ({ url, store, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [
        {
          type: "annotation",
          file: "src/api/users.ts",
          group: "API Handlers",
          selected_text: "+new",
          comment: "wrap in a transaction",
        },
      ],
      ended: false,
    });

    const queued = store.get(key)!.pending[0] as { id?: string };
    const record = (ledger?.read({}).records ?? []).find((entry) => entry.kind === "annotation");
    assert.equal(queued.id, "t1");
    assert.match(record?.id ?? "", /^evt_/);
  });
});

test("a publish --to note is written to the ledger as the agent's reply", async () => {
  await withServer("on", async ({ url, store, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "use a constant" }],
      ended: false,
    });
    await pollAndAck(url, key);

    const published = await publishNext(url, store, key, {
      ...sessionPayload,
      headCommit: "ccc3333",
      intents: ["a constant now"],
      notes: [{ to: "t1", text: "done: a constant now" }],
    });

    assert.equal(published.status, 200);
    const replies = (ledger?.read({}).records ?? []).filter((r) => r.kind === "agent_reply");
    assert.equal(replies.length, 1);
    assert.partialDeepStrictEqual(replies[0], { comment: "done: a constant now" });
    assert.equal(
      (ledger?.read({ kind: "declaration" }).records ?? []).length,
      0,
      "3.0 writes no declarations",
    );
  });
});

test("with the ledger off, thread ids and replies still work off the session alone", async () => {
  await withServer("off", async ({ url, store }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "why?" }],
      ended: false,
    });
    await pollAndAck(url, key);

    const response = await postJson(`${url}/api/session/${key}/reply`, {
      replies: [{ to: "t1", text: "because" }],
    });

    assert.equal(response.status, 200);
    assert.equal(store.get(key)!.conversation.at(-1)?.role, "agent");
  });
});

test("the first round of a session judges nothing", async () => {
  await withServer("on", async ({ url, ledger }) => {
    await startRound(url);

    assert.deepEqual(outcomes(ledger), []);
  });
});

function kinds(ledger: LedgerStore | undefined): string[] {
  return (ledger?.read({}).records ?? []).map((record) => record.kind);
}

test("a full round leaves exactly the records that round produced", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/approved`, { approved: ["src/api/users.ts"] });
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [
        {
          type: "annotation",
          file: "src/api/users.ts",
          group: "API Handlers",
          selected_text: "+new",
          comment: "Return a ReviewError",
        },
        { type: "message", comment: "Please add tests" },
      ],
      ended: false,
    });
    await pollAndAck(url, key);
    const replied = await postJson(`${url}/api/session/${key}/reply`, {
      replies: [{ to: "t1", text: "Fixed" }],
    });
    assert.equal(replied.status, 200);
    await postJson(`${url}/api/session/${key}/end`, {});

    assert.deepEqual(kinds(ledger), [
      "round",
      "round_file",
      "annotation",
      "message",
      "agent_reply",
      "round_end",
    ]);
  });
});

test("ledger ids are monotonic in the order the records were written", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "one" }],
      ended: false,
    });

    const ids = (ledger?.read({}).records ?? []).map((record) => record.id);
    assert.deepEqual([...ids].sort(), ids);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test("every record of a round is anchored to the round the session is showing", async () => {
  await withServer("on", async ({ url, store, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "one" }],
      ended: false,
    });

    const round = store.get(key)?.round;
    assert.match(round ?? "", /^rnd_/);
    const anchors = (ledger?.read({}).records ?? []).map(roundOf);
    assert.deepEqual([...new Set(anchors)], [round]);
  });
});

function roundOf(record: LedgerRecord): string | undefined {
  return "round" in record ? record.round : undefined;
}

test("a binary file gets no round_file record — there is no patch to keep", async () => {
  await withServer("on", async ({ url, ledger }) => {
    await startRound(url);

    const files = (ledger?.read({}).records ?? []).filter((record) => record.kind === "round_file");
    assert.deepEqual(
      files.map((record) => (record.kind === "round_file" ? record.file : "")),
      ["src/api/users.ts"],
    );
  });
});

test("ending from the browser records the round end once, with the approved set", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/approved`, { approved: ["src/api/users.ts"] });
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "done" }],
      ended: true,
    });

    const ends = (ledger?.read({}).records ?? []).filter((record) => record.kind === "round_end");
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0]?.kind === "round_end" ? ends[0].approved : [], ["src/api/users.ts"]);
  });
});

/**
 * A second `end` has nothing to close: re-closing it logged another round end
 * and re-stamped the record while the CLI said nothing was left to close.
 */
test("ending a review that is already ended writes nothing and logs nothing", async () => {
  await withServer("on", async ({ url, store, ledger }) => {
    const { key } = await startRound(url);
    await fetch(`${url}/api/session/${key}/end`, { method: "POST" });
    const ended = store.get(key)!;
    const logged = ledger?.read({}).records.length;

    const again = await fetch(`${url}/api/session/${key}/end`, { method: "POST" });

    assert.equal(again.status, 200);
    assert.partialDeepStrictEqual(await again.json(), { status: "ended", turn: "ended" });
    assert.deepEqual(store.get(key), ended);
    assert.equal(ledger?.read({}).records.length, logged);
    const ends = (ledger?.read({}).records ?? []).filter((record) => record.kind === "round_end");
    assert.equal(ends.length, 1);
  });
});

test("ending with nothing said keeps the ledger to what happened", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/approved`, { approved: ["src/api/users.ts"] });
    await postJson(`${url}/api/session/${key}/feedback`, { prompts: [], ended: true });

    const records = ledger?.read({}).records ?? [];
    // No prompts means no annotation and no message record: an empty one would
    // stand for a comment the reviewer never wrote.
    assert.deepEqual(
      records.filter((record) => record.kind === "annotation" || record.kind === "message"),
      [],
    );
    const ends = records.filter((record) => record.kind === "round_end");
    assert.equal(ends.length, 1, "the round still ends, and says so once");
    assert.deepEqual(ends[0]?.kind === "round_end" ? ends[0].approved : [], ["src/api/users.ts"]);
  });
});

test("a round-end record separates approval earned here from approval carried in", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/approved`, { approved: ["src/api/users.ts"] });
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "looks right" }],
      ended: true,
    });
    // Same diff again: the file did not move, so its approval carries over.
    await reopenRound(url);
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "still fine" }],
      ended: true,
    });

    const ends = (ledger?.read({}).records ?? []).filter((record) => record.kind === "round_end");
    assert.deepEqual(
      ends.map((record) => (record.kind === "round_end" ? record.approved : [])),
      [["src/api/users.ts"], []],
    );
    assert.deepEqual(
      ends.map((record) => (record.kind === "round_end" ? record.carried : [])),
      [[], ["src/api/users.ts"]],
    );
  });
});

test("approval from a round nobody ended is logged as carried, not earned again", async () => {
  await withServer("on", async ({ url, store, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/approved`, { approved: ["src/api/users.ts"] });
    // "Send to Agent": the round stays open, and the agent publishes the next one.
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "one more pass" }],
    });
    assert.equal((await publishNext(url, store, key)).status, 200);
    await postJson(`${url}/api/session/${key}/end`, {});

    const ends = (ledger?.read({}).records ?? []).filter((record) => record.kind === "round_end");
    assert.deepEqual(
      ends.map((record) => (record.kind === "round_end" ? [record.approved, record.carried] : [])),
      [[[], ["src/api/users.ts"]]],
    );
  });
});

test("a round-file record says where each file stood when the round opened", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/approved`, { approved: ["src/api/users.ts"] });
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "looks right" }],
      ended: true,
    });
    await reopenRound(url);

    const files = (ledger?.read({}).records ?? []).filter((record) => record.kind === "round_file");
    assert.deepEqual(
      files.map((record) => (record.kind === "round_file" ? record.approval : "")),
      ["unapproved", "approved"],
    );
  });
});

test("a round-file record remembers which round the file entered the review in", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "one more round" }],
      ended: true,
    });
    await reopenRound(url);

    const files = (ledger?.read({}).records ?? []).filter((record) => record.kind === "round_file");
    assert.deepEqual(
      files.map((record) => (record.kind === "round_file" ? record.first_seen_round : -1)),
      [0, 0],
    );
  });
});

test("a healthy ledger is reported with its path when a round starts", async () => {
  await withServer("on", async ({ url, ledger }) => {
    const created = await startRound(url);

    assert.equal(created.ledger.status, "on");
    assert.equal(created.ledger.path, ledger?.path);
    assert.equal(created.ledger.reason, undefined);
  });
});

test("feedbackLog off reports off and writes nothing anywhere", async () => {
  await withServer("off", async ({ url, store }) => {
    const created = await startRound(url);
    await postJson(`${url}/api/session/${created.key}/feedback`, {
      prompts: [{ type: "message", comment: "one" }],
      ended: true,
    });

    assert.equal(created.ledger.status, "off");
    assert.equal(created.ledger.path, undefined);
    assert.equal(store.get(created.key)?.conversation.length, 1);
  });
});

test("an unwritable ledger degrades the report but the review still works", async () => {
  await withServer("broken", async ({ url, store }) => {
    const created = await startRound(url);
    const feedback = await postJson(`${url}/api/session/${created.key}/feedback`, {
      prompts: [{ type: "message", comment: "one" }],
      ended: false,
    });

    assert.equal(created.ledger.status, "degraded");
    assert.match(created.ledger.reason ?? "", /ENOTDIR|not a directory/i);
    assert.equal(feedback.status, 200);
    assert.equal(store.get(created.key)?.conversation.length, 1);
  });
});
