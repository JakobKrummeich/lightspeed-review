import { test } from "node:test";
import assert from "node:assert/strict";
import { batchItems, openIds, threadsOf } from "../src/threads.ts";
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

/** A thread across two rounds: asked in round 0, answered, answered back, then done in round 1. */
const lineAsk: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-01T00:00:00.000Z",
  roundIndex: 0,
  prompts: [
    {
      type: "annotation",
      id: "t1",
      file: "greet.ts",
      group: "All",
      side: "new",
      line_start: 5,
      line_end: 5,
      selected_text: "export const shout",
      comment: "Rename shout → yell.",
    },
    { type: "message", id: "t2", comment: "Also add a JSDoc comment." },
  ],
};
const history: ConversationEntry[] = [
  lineAsk,
  {
    role: "agent",
    at: "2025-01-01T00:01:00.000Z",
    roundIndex: 0,
    prompts: [
      { type: "reply", thread: "t1", comment: "Keep an alias?" },
      { type: "reply", thread: "t2", comment: "On yell too?" },
    ],
  },
  {
    role: "reviewer",
    at: "2025-01-01T00:02:00.000Z",
    roundIndex: 0,
    prompts: [
      { type: "reply", thread: "t1", comment: "No alias." },
      { type: "reply", thread: "t2", comment: "Both." },
    ],
  },
  {
    role: "agent",
    at: "2025-01-01T00:03:00.000Z",
    roundIndex: 1,
    prompts: [{ type: "reply", thread: "t1", comment: "done: renamed" }],
  },
];
const roundTwoSend: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-01T00:04:00.000Z",
  roundIndex: 1,
  prompts: [
    { type: "reply", thread: "t2", comment: "One line each." },
    { type: "resolve", thread: "t2", resolved: true },
    { type: "reply", thread: "t1", comment: "Also the README." },
  ],
};

test("an open thread comes with everything said in it before, then only the new words", () => {
  const [, t1] = batchItems(roundTwoSend.prompts, [...history, roundTwoSend]);

  assert.deepEqual(t1, {
    id: "t1",
    status: "reply",
    file: "greet.ts",
    side: "new",
    line_start: 5,
    line_end: 5,
    selected_text: "export const shout",
    anchoredIn: 0,
    thread: [
      { who: "reviewer", said: "Rename shout → yell." },
      { who: "you", said: "Keep an alias?" },
      { who: "reviewer", said: "No alias." },
      { who: "you", said: "done: renamed" },
    ],
    reviewer: ["Also the README."],
  });
});

test("a thread resolved in this batch carries only what it asked and the last words", () => {
  const [t2] = batchItems(roundTwoSend.prompts, [...history, roundTwoSend]);

  assert.deepEqual(t2, {
    id: "t2",
    status: "resolved",
    asked: "Also add a JSDoc comment.",
    reviewer: ["One line each."],
  });
  const bare = batchItems(
    [{ type: "resolve", thread: "t1", resolved: true }],
    [...history, { ...roundTwoSend, prompts: [{ type: "resolve", thread: "t1", resolved: true }] }],
  );
  assert.deepEqual(bare, [
    { id: "t1", status: "resolved", asked: "Rename shout → yell.", reviewer: [] },
  ]);
});

test("words the reviewer said twice in a row before this batch stay in the history", () => {
  const again: ConversationEntry = {
    role: "reviewer",
    at: "2025-01-01T00:05:00.000Z",
    roundIndex: 1,
    prompts: [{ type: "reply", thread: "t1", comment: "Skip the README." }],
  };
  const [t1] = batchItems(again.prompts, [...history, roundTwoSend, again]);

  assert.equal(t1?.status, "reply");
  assert.deepEqual(t1?.status === "reply" ? t1.thread.slice(-2) : [], [
    { who: "you", said: "done: renamed" },
    { who: "reviewer", said: "Also the README." },
  ]);
  assert.deepEqual(t1?.reviewer, ["Skip the README."]);
});

test("a new item is its own ask: no history, anchored in the round it was sent in", () => {
  const [t1, t2] = batchItems(lineAsk.prompts, [lineAsk]);

  assert.deepEqual(t1, {
    id: "t1",
    status: "new",
    file: "greet.ts",
    side: "new",
    line_start: 5,
    line_end: 5,
    selected_text: "export const shout",
    anchoredIn: 0,
    reviewer: ["Rename shout → yell."],
  });
  assert.deepEqual(t2, { id: "t2", status: "new", reviewer: ["Also add a JSDoc comment."] });
});
