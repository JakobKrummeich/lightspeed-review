import assert from "node:assert/strict";
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
        { role: "reviewer", at: "a", prompts: [{ type: "message", id: "t1", comment: "old" }] },
        { role: "agent", at: "b", prompts: [{ type: "reply", thread: "t1", comment: "ok" }] },
        { role: "reviewer", at: "c", prompts: [{ type: "message", id: "t2", comment: "new" }] },
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
  assert.equal(migrated.batch, batch);
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

test("an unconfirmed delivery under a working turn leaves the turn alone", () => {
  const migrated = migrateV2(
    v2Session({
      turn: { holder: "agent", mode: "working", at: "w" },
      delivering: { id: "d", prompts: [{ type: "message", id: "t1", comment: "x" }], at: "w" },
    }),
  );
  assert.equal(migrated.turn.holder, "agent");
  assert.equal(migrated.pending.length, 1);
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
