import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { migrateV2 } from "../src/session-migrate.ts";
import type { SessionRecord } from "../src/session-types.ts";

function v2Session(extra: Record<string, unknown> = {}): SessionRecord {
  return {
    key: "k",
    repoRoot: "/repo",
    branch: "feature",
    base: "main",
    status: "open",
    turn: { holder: "reviewer", at: "2024-01-01T00:00:00.000Z" },
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    groups: [],
    conversation: [],
    pending: [],
    approved: [],
    rounds: [],
    ...extra,
  } as SessionRecord;
}

test("a session from before turns opens with the reviewer holding it", () => {
  const migrated = migrateV2(v2Session({ turn: undefined }));
  assert.deepEqual(migrated.turn, { holder: "reviewer", at: "2024-01-02T00:00:00.000Z" });
});

test("2.x's reading turn becomes digesting, with the batch rebuilt from the reviewer's words", () => {
  const migrated = migrateV2(
    v2Session({
      turn: { holder: "agent", mode: "reading", at: "2024-01-03T00:00:00.000Z" },
      conversation: [
        {
          role: "reviewer",
          at: "2024-01-01T00:00:00.000Z",
          prompts: [{ type: "message", id: "t1", comment: "old" }],
        },
        {
          role: "agent",
          at: "2024-01-01T01:00:00.000Z",
          prompts: [{ type: "reply", thread: "t1", comment: "ok" }],
        },
        {
          role: "reviewer",
          at: "2024-01-02T00:00:00.000Z",
          prompts: [{ type: "message", id: "t2", comment: "new" }],
        },
      ],
    }),
  );
  assert.deepEqual(migrated.turn, {
    holder: "agent",
    mode: "digesting",
    at: "2024-01-03T00:00:00.000Z",
  });
  assert.deepEqual(migrated.batch, {
    id: "migrated",
    prompts: [{ type: "message", id: "t2", comment: "new" }],
    at: "2024-01-03T00:00:00.000Z",
    acked: true,
  });
});

test("a working turn keeps its note and gets a batch of everything when the agent never spoke", () => {
  const migrated = migrateV2(
    v2Session({
      turn: { holder: "agent", mode: "working", at: "w", note: "plan" },
      conversation: [
        { role: "reviewer", at: "a", prompts: [{ type: "message", id: "t1", comment: "fix" }] },
      ],
    }),
  );
  assert.deepEqual(migrated.turn, { holder: "agent", mode: "working", at: "w", note: "plan" });
  assert.deepEqual(migrated.batch?.prompts, [{ type: "message", id: "t1", comment: "fix" }]);
});

test("an agent turn that already carries a batch keeps it", () => {
  const batch = { id: "b1", prompts: [], at: "x", acked: false };
  const migrated = migrateV2(
    v2Session({ turn: { holder: "agent", mode: "digesting", at: "x" }, batch }),
  );
  assert.deepEqual(migrated.batch, batch);
});

test("an unconfirmed delivery goes back to the head of the queue and the turn back to the reviewer", () => {
  const delivered = { type: "message", id: "t1", comment: "first" };
  const queued = { type: "message", id: "t2", comment: "second" };
  const migrated = migrateV2(
    v2Session({
      turn: { holder: "agent", mode: "reading", at: "r" },
      delivering: { id: "d", prompts: [delivered], at: "r" },
      pending: [queued],
    }),
  );
  assert.deepEqual(migrated.pending, [delivered, queued]);
  assert.deepEqual(migrated.turn, { holder: "reviewer", at: "r" });
  assert.equal("delivering" in migrated, false);
  assert.equal(migrated.batch, undefined);
});

test("an unconfirmed delivery under a working turn is the batch being worked on, not queued again", () => {
  const delivered = { type: "message", id: "t1", comment: "x" };
  const migrated = migrateV2(
    v2Session({
      turn: { holder: "agent", mode: "working", at: "w" },
      conversation: [{ role: "reviewer", at: "v", prompts: [delivered] }],
      delivering: { id: "d", prompts: [delivered], at: "v" },
    }),
  );
  assert.equal(migrated.turn.holder, "agent");
  assert.equal(migrated.pending.length, 0, "working means it was read: never delivered twice");
  assert.deepEqual(migrated.batch?.prompts, [delivered]);
});

test("say --for answers become agent replies in their thread, placed by time", () => {
  const migrated = migrateV2(
    v2Session({
      conversation: [
        {
          role: "reviewer",
          at: "2024-01-01",
          prompts: [{ type: "message", id: "t1", comment: "q" }],
        },
        {
          role: "reviewer",
          at: "2024-01-05",
          prompts: [{ type: "message", id: "t2", comment: "r" }],
        },
      ],
      declarations: {
        t1: { note: "answered", files: [], at: "2024-01-03" },
        t2: { note: "", files: ["a.ts"], at: "2024-01-06" },
        t3: { files: [], at: "2024-01-07" },
      },
    }),
  );
  assert.equal("declarations" in migrated, false);
  assert.deepEqual(
    migrated.conversation.map((entry) => entry.at),
    ["2024-01-01", "2024-01-03", "2024-01-05"],
  );
  assert.deepEqual(migrated.conversation[1], {
    role: "agent",
    at: "2024-01-03",
    prompts: [{ type: "reply", thread: "t1", comment: "answered" }],
  });
});

test("answers stamped at the same moment keep their order", () => {
  const migrated = migrateV2(
    v2Session({
      conversation: [{ role: "reviewer", at: "s", prompts: [] }],
      declarations: { t1: { note: "one", files: [], at: "s" } },
    }),
  );
  assert.deepEqual(
    migrated.conversation.map((entry) => entry.role),
    ["reviewer", "agent"],
  );
});

test("a queued general message with no id gets the next thread id, in the queue and in the conversation", () => {
  const migrated = migrateV2(
    v2Session({
      conversation: [
        { role: "reviewer", at: "a", prompts: [{ type: "message", id: "t3", comment: "had one" }] },
        { role: "reviewer", at: "b", prompts: [{ type: "message", comment: "needs one" }] },
      ],
      pending: [
        { type: "message", comment: "needs one" },
        { type: "message", comment: "never recorded" },
        { type: "reply", thread: "t3", comment: "left alone" },
      ],
    }),
  );
  assert.deepEqual(migrated.pending, [
    { type: "message", comment: "needs one", id: "t4" },
    { type: "message", comment: "never recorded", id: "t5" },
    { type: "reply", thread: "t3", comment: "left alone" },
  ]);
  assert.deepEqual(migrated.conversation[1]!.prompts, [
    { type: "message", comment: "needs one", id: "t4" },
  ]);
  assert.deepEqual(migrated.conversation[0]!.prompts, [
    { type: "message", id: "t3", comment: "had one" },
  ]);
});

test("a session 3.0 wrote comes through unchanged", () => {
  const session = v2Session({
    turn: { holder: "agent", mode: "digesting", at: "x" },
    batch: { id: "b", prompts: [], at: "x", acked: true },
    pending: [{ type: "message", id: "t1", comment: "c" }],
  });
  assert.deepEqual(migrateV2(session), session);
});

/**
 * A real 2.x file: the agent was reading its first batch, answered one item
 * with `say --for` and chatted once, and the reviewer queued two more items
 * meanwhile — which 2.x recorded both in the conversation and in `pending`.
 */
function realV2(): SessionRecord {
  const url = new URL("./fixtures/sessions/v2-reading.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as SessionRecord;
}

function words(prompts: readonly { type: string }[]): string[] {
  return prompts.map((prompt) => (prompt as { comment?: string }).comment ?? prompt.type);
}

test("a real 2.x reading session: the agent holds the batch it was delivered, the queue stays queued, nothing twice", () => {
  const migrated = migrateV2(realV2());

  assert.deepEqual(migrated.turn, {
    holder: "agent",
    mode: "digesting",
    at: "2026-09-25T22:10:54.083Z",
  });
  assert.deepEqual(words(migrated.batch!.prompts), ["why 2?", "general v2 q"]);
  assert.deepEqual(words(migrated.pending), ["queued while reading", "queued line"]);
  const batchIds = migrated.batch!.prompts.map((prompt) => (prompt as { id?: string }).id);
  const pendingIds = migrated.pending.map((prompt) => (prompt as { id?: string }).id);
  assert.deepEqual(batchIds, ["evt_0muhilres_0004", "t1"]);
  assert.deepEqual(pendingIds, ["t2", "evt_0muhilv37_0009"]);
  // The id-less message reads as the same thread in the conversation as in the batch.
  const said = migrated.conversation.flatMap((entry) => entry.prompts);
  assert.ok(said.some((prompt) => prompt.type === "message" && prompt.id === "t1"));
  assert.ok(said.some((prompt) => prompt.type === "message" && prompt.id === "t2"));
});

test("a 2.x agent turn whose every recent word is still queued goes back to the reviewer", () => {
  const queued = { type: "message", comment: "queued while reading" };
  const migrated = migrateV2(
    v2Session({
      turn: { holder: "agent", mode: "reading", at: "2024-01-03T00:00:00.000Z" },
      conversation: [{ role: "reviewer", at: "2024-01-02T00:00:00.000Z", prompts: [queued] }],
      pending: [queued],
    }),
  );
  assert.deepEqual(migrated.turn, { holder: "reviewer", at: "2024-01-03T00:00:00.000Z" });
  assert.equal(migrated.batch, undefined);
  assert.equal(migrated.pending.length, 1);
});
