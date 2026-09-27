import { test } from "node:test";
import assert from "node:assert/strict";
import { arrivesByJump } from "../../src/browser/round-arrival.ts";
import type { ConversationEntry, RoundMark } from "../../src/session-store.ts";

const rounds: RoundMark[] = [
  { index: 0, at: "2025-01-01T00:00:00.000Z" },
  { index: 1, at: "2025-01-02T00:00:00.000Z" },
];

const commented: ConversationEntry[] = [
  {
    role: "reviewer",
    at: "2025-01-01T01:00:00.000Z",
    roundIndex: 0,
    prompts: [
      { type: "annotation", file: "a.ts", group: "A", selected_text: "x", comment: "why?" },
    ],
  },
];

const spoken: ConversationEntry[] = [
  {
    role: "reviewer",
    at: "2025-01-01T01:00:00.000Z",
    roundIndex: 0,
    prompts: [{ type: "message", comment: "looks fine" }],
  },
];

test("a round whose last round was commented on, never replayed, arrives by a jump", () => {
  const fresh = { rounds, conversation: commented, status: "open" } as const;

  assert.equal(arrivesByJump(fresh, undefined), true);
  assert.equal(arrivesByJump(fresh, 0), true, "the replay remembered is an older round's");
});

test("the replay it opens was already shown here: no jump, as the replay will not open", () => {
  assert.equal(arrivesByJump({ rounds, conversation: commented, status: "open" }, 1), false);
});

test("no comment last round, nothing to replay: the round just applies", () => {
  assert.equal(arrivesByJump({ rounds, conversation: spoken, status: "open" }, undefined), false);
  assert.equal(arrivesByJump({ rounds, conversation: [], status: "open" }, undefined), false);
});

test("an ended review never jumps: the replay does not open over a finished review", () => {
  assert.equal(
    arrivesByJump({ rounds, conversation: commented, status: "ended" }, undefined),
    false,
  );
});

test("a first round has no round before it to replay", () => {
  const first = { rounds: rounds.slice(0, 1), conversation: commented, status: "open" } as const;

  assert.equal(arrivesByJump(first, undefined), false);
});
