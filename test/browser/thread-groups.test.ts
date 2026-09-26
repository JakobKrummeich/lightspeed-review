import { test } from "node:test";
import assert from "node:assert/strict";
import { cardShut, groupCards, openingWords } from "../../src/browser/thread-groups.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../src/session-store.ts";

const at = (minute: number): string => `2025-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

function said(
  role: "reviewer" | "agent",
  minute: number,
  ...prompts: FeedbackPrompt[]
): ConversationEntry {
  return { role, at: at(minute), prompts };
}

const ask = (id: string, comment = `ask ${id}`): FeedbackPrompt => ({
  type: "message",
  id,
  comment,
});
const answer = (thread: string, comment = `answer in ${thread}`): FeedbackPrompt => ({
  type: "reply",
  thread,
  comment,
});

function shape(conversation: ConversationEntry[]) {
  return groupCards(conversation).map((group) => ({
    name: group.name,
    keys: group.cards.map((card) => card.key),
  }));
}

test("threads fall into resolved, waiting on the agent, and needing the reviewer, in that order", () => {
  const conversation = [
    said("reviewer", 1, ask("t1"), ask("t2"), ask("t3")),
    said("agent", 2, answer("t1"), answer("t3")),
    said("reviewer", 3, { type: "resolve", thread: "t3", resolved: true }),
  ];

  assert.deepEqual(shape(conversation), [
    { name: "resolved", keys: ["t3"] },
    { name: "waiting", keys: ["t2"] },
    { name: "needs", keys: ["t1"] },
  ]);
});

test("a group with nothing in it is left out", () => {
  assert.deepEqual(shape([said("reviewer", 1, ask("t1"))]), [{ name: "waiting", keys: ["t1"] }]);
  assert.deepEqual(shape([]), []);
});

test("within a group the latest activity from either side comes last", () => {
  const conversation = [
    said("reviewer", 1, ask("t1"), ask("t2")),
    said("agent", 2, answer("t2")),
    said("agent", 3, answer("t1")),
    said("reviewer", 4, answer("t2", "and this?")),
    said("agent", 5, answer("t2")),
  ];

  assert.deepEqual(shape(conversation), [{ name: "needs", keys: ["t1", "t2"] }]);
});

test("the reviewer speaking last moves a thread to waiting, even after the agent answered", () => {
  const conversation = [
    said("reviewer", 1, ask("t1")),
    said("agent", 2, answer("t1")),
    said("reviewer", 3, answer("t1", "not quite")),
  ];

  assert.deepEqual(shape(conversation), [{ name: "waiting", keys: ["t1"] }]);
});

test("the agent's own posts need the reviewer while fresh and settle once the reviewer has sent since", () => {
  const conversation = [
    said("reviewer", 1, ask("t1")),
    said("agent", 2, answer("main", "heads up")),
    said("reviewer", 3, answer("t1", "more")),
    said("agent", 4, answer("main", "done")),
  ];

  const groups = groupCards(conversation);

  assert.deepEqual(
    groups.map((group) => [group.name, group.cards.map((card) => card.key)]),
    [
      ["resolved", [`main@${at(2)}`]],
      ["waiting", ["t1"]],
      ["needs", [`main@${at(4)}`]],
    ],
  );
  assert.equal(groups[2]?.cards[0]?.fresh, true);
  assert.equal(groups[2]?.cards[0]?.main, true);
});

test("words from before threads had ids are history: resolved, and keyed by their order", () => {
  const conversation = [said("reviewer", 1, { type: "message", comment: "old words" })];

  const [group] = groupCards(conversation);

  assert.equal(group?.name, "resolved");
  assert.equal(group?.cards[0]?.key, "legacy@0");
  assert.equal(group?.cards[0]?.fresh, false);
});

test("a card is shut by default exactly when it is settled or a resolve is queued for it", () => {
  const conversation = [
    said("reviewer", 1, ask("t1"), ask("t2")),
    said("reviewer", 2, { type: "resolve", thread: "t2", resolved: true }),
  ];
  const cards = groupCards(conversation).flatMap((group) => group.cards);
  const t1 = cards.find((card) => card.key === "t1")!;
  const t2 = cards.find((card) => card.key === "t2")!;

  assert.equal(cardShut(t1, undefined, {}), false);
  assert.equal(cardShut(t2, undefined, {}), true);
  assert.equal(cardShut(t1, true, {}), true, "a queued resolve folds it at the press");
  assert.equal(cardShut(t2, false, {}), false, "a queued reopen unfolds it");
});

test("the reviewer's own fold holds only while the thread is still as settled as when chosen", () => {
  const cards = groupCards([said("reviewer", 1, ask("t1"))]).flatMap((group) => group.cards);
  const t1 = cards[0]!;

  assert.equal(cardShut(t1, undefined, { t1: { shut: true, resolved: false } }), true);
  assert.equal(
    cardShut(t1, undefined, { t1: { shut: false, resolved: true } }),
    false,
    "a choice made while resolved is not applied to the open thread",
  );
  assert.equal(cardShut(t1, true, { t1: { shut: false, resolved: true } }), false);
});

test("a card's short name is the first words of what opened it", () => {
  const conversation = [
    said(
      "reviewer",
      1,
      ask("t1", "this function does far too much and should be split into three smaller ones"),
      ask("t2", "short"),
    ),
  ];
  const cards = groupCards(conversation).flatMap((group) => group.cards);

  assert.equal(openingWords(cards[0]!), "this function does far too much and should…");
  assert.equal(openingWords(cards[1]!), "short");
});
