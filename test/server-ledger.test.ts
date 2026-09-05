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

/** The round after a `Send & End`, which only the reviewer's `--reopen` allows. */
async function reopenRound(
  url: string,
  payload: Record<string, unknown> = sessionPayload,
): Promise<Created> {
  return await startRound(url, { ...payload, reopen: true });
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

test("a queued annotation and its ledger record share one id", async () => {
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
    assert.match(queued.id ?? "", /^evt_/);
    assert.equal(record?.id, queued.id);
  });
});

/** One reviewed round answered by a second: the shape every declaration is made in. */
async function declaredRounds(url: string, store: SessionStore) {
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
    ended: false,
  });
  const id = (store.get(key)!.pending[0] as { id: string }).id;
  await startRound(url, roundPayload(repoRoot, second, "3333ccc"));
  return { key, id };
}

test("a declared file the between-round diff touched passes; one it never did is refused", async () => {
  await withServer("on", async ({ url, store }) => {
    const { key, id } = await declaredRounds(url, store);

    const accepted = await postJson(`${url}/api/session/${key}/reply`, {
      comment: "made it a constant",
      declarations: [{ id, note: "a constant now", files: ["users.ts"] }],
    });
    const refused = await postJson(`${url}/api/session/${key}/reply`, {
      comment: "made it a constant",
      declarations: [{ id, note: "a constant now", files: ["untouched.ts"] }],
    });

    assert.equal(accepted.status, 200);
    assert.equal(refused.status, 422);
    const body = (await refused.json()) as { error: { detail: string } };
    assert.match(body.error.detail, /untouched\.ts is not in the between-round diff/);
  });
});

test("an accepted declaration is written to the ledger, about the annotation's id", async () => {
  await withServer("on", async ({ url, store, ledger }) => {
    const { key, id } = await declaredRounds(url, store);

    await postJson(`${url}/api/session/${key}/reply`, {
      comment: "made it a constant",
      declarations: [{ id, note: "a constant now", files: ["users.ts"] }],
    });

    const records = ledger?.read({ kind: "declaration" }).records ?? [];
    assert.equal(records.length, 1);
    assert.partialDeepStrictEqual(records[0], {
      kind: "declaration",
      about: id,
      note: "a constant now",
      files: ["users.ts"],
      round: store.get(key)?.round,
    });
  });
});

test("an accepted declaration survives the next start", async () => {
  await withServer("on", async ({ url, store }) => {
    const { key, id } = await declaredRounds(url, store);
    await postJson(`${url}/api/session/${key}/reply`, {
      comment: "made it a constant",
      declarations: [{ id, note: "a constant now", files: ["users.ts"] }],
    });
    const repoRoot = store.get(key)!.repoRoot;
    const head = store.get(key)!.headCommit!;

    // The round boundary the replay reads from: a new `start` must not shed
    // the only ledger-independent copy of the agent's word.
    await startRound(url, roundPayload(repoRoot, head, "4444ddd"));

    assert.partialDeepStrictEqual(store.get(key)!.declarations, {
      [id]: { note: "a constant now", files: ["users.ts"] },
    });
  });
});

test("re-sending the same declaration is safe: one entry, same content", async () => {
  await withServer("on", async ({ url, store }) => {
    const { key, id } = await declaredRounds(url, store);
    const reply = {
      comment: "made it a constant",
      declarations: [{ id, note: "a constant now", files: ["users.ts"] }],
    };

    assert.equal((await postJson(`${url}/api/session/${key}/reply`, reply)).status, 200);
    assert.equal((await postJson(`${url}/api/session/${key}/reply`, reply)).status, 200);

    const declarations = store.get(key)!.declarations!;
    assert.deepEqual(Object.keys(declarations), [id]);
    assert.partialDeepStrictEqual(declarations[id], {
      note: "a constant now",
      files: ["users.ts"],
    });
  });
});

test("with the ledger off, ids and declarations still work off the session alone", async () => {
  await withServer("off", async ({ url, store }) => {
    const { key, id } = await declaredRounds(url, store);

    const response = await postJson(`${url}/api/session/${key}/reply`, {
      comment: "made it a constant",
      declarations: [{ id, note: "a constant now", files: ["users.ts"] }],
    });

    assert.match(id, /^evt_/);
    assert.equal(response.status, 200);
    assert.partialDeepStrictEqual(store.get(key)!.declarations?.[id], {
      note: "a constant now",
      files: ["users.ts"],
    });
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
    await postJson(`${url}/api/session/${key}/reply`, { comment: "Fixed" });
    await postJson(`${url}/api/session/${key}/end`, {});

    assert.deepEqual(kinds(ledger), [
      "round",
      "round_file",
      "annotation",
      "message",
      "agent_reply",
      "round_end",
    ]);
    // A reply that declares nothing writes no `declaration` record: an empty
    // one would read as the agent having said "nothing", which it never did.
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
  await withServer("on", async ({ url, ledger }) => {
    const { key } = await startRound(url);
    await postJson(`${url}/api/session/${key}/approved`, { approved: ["src/api/users.ts"] });
    // "Send to Agent": the round stays open, and the agent starts the next one.
    await postJson(`${url}/api/session/${key}/feedback`, {
      prompts: [{ type: "message", comment: "one more pass" }],
    });
    await startRound(url);
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
