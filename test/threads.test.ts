import { test } from "node:test";
import assert from "node:assert/strict";
import { openIds, threadsOf } from "../src/threads.ts";
import type { ConversationEntry } from "../src/session-types.ts";

const asked: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-01T00:00:00.000Z",
  prompts: [
    { type: "message", id: "t1", comment: "why 2?" },
    { type: "message", id: "t2", comment: "rename a" },
  ],
};
const resolvedT1: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-01T00:02:00.000Z",
  prompts: [{ type: "resolve", thread: "t1", resolved: true }],
};

test("the agent speaking into a resolved thread reopens it", () => {
  const conversation: ConversationEntry[] = [
    asked,
    resolvedT1,
    {
      role: "agent",
      at: "2025-01-01T00:03:00.000Z",
      prompts: [{ type: "reply", thread: "t1", comment: "one more thing about 2" }],
    },
  ];

  const t1 = threadsOf(conversation).find((thread) => thread.id === "t1")!;
  assert.equal(t1.resolved, false);
  assert.equal(t1.messages.at(-1)?.comment, "one more thing about 2");
});

test("open ids are the held batch's open threads first, never a resolved one or main", () => {
  const conversation: ConversationEntry[] = [
    asked,
    resolvedT1,
    {
      role: "agent",
      at: "2025-01-01T00:04:00.000Z",
      prompts: [{ type: "reply", thread: "main", comment: "all good" }],
    },
  ];

  assert.deepEqual(openIds(conversation, resolvedT1.prompts), ["t2"]);
  assert.deepEqual(openIds(conversation, asked.prompts), ["t2"]);
  assert.deepEqual(
    openIds([
      asked,
      {
        ...resolvedT1,
        prompts: [
          { type: "resolve", thread: "t1", resolved: true },
          { type: "resolve", thread: "t2", resolved: true },
        ],
      },
    ]),
    [],
  );
});
