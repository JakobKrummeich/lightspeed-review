import { test } from "node:test";
import assert from "node:assert/strict";
import { agentMessages, messageNews } from "../../src/browser/message-news.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../src/session-store.ts";

const at = (minute: number): string => `2025-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

function said(
  role: "reviewer" | "agent",
  minute: number,
  ...prompts: FeedbackPrompt[]
): ConversationEntry {
  return { role, at: at(minute), prompts };
}

const ask = (id: string): FeedbackPrompt => ({ type: "message", id, comment: `ask ${id}` });
const answer = (thread: string): FeedbackPrompt => ({
  type: "reply",
  thread,
  comment: `answer in ${thread}`,
});

const asked = [said("reviewer", 1, ask("t1"), ask("t2"))];
const answered = [...asked, said("agent", 2, answer("t1"))];

test("what the page opened on is seen: the first draw lights nothing", () => {
  assert.deepEqual(messageNews(agentMessages(answered), answered).cards, []);
});

test("an agent answer since the last draw is news, named by its card", () => {
  const news = messageNews(agentMessages(asked), answered);

  assert.deepEqual(news.cards, ["t1"]);
  // And it is seen from here on: the next draw of the same talk is quiet.
  assert.deepEqual(messageNews(news.seen, answered).cards, []);
});

test("the reviewer's own words are never news, sent or echoed", () => {
  const followUp = [...answered, said("reviewer", 3, answer("t1"), ask("t3"))];

  assert.deepEqual(messageNews(agentMessages(answered), followUp).cards, []);
});

test("one reply answering several threads lights each card once, top to bottom", () => {
  const both = [
    ...asked,
    said("agent", 2, answer("t2"), answer("t1")),
    said("agent", 3, answer("t1")),
  ];

  // t1 has two new answers and is still one card; `main` posts are cards of their own. In the
  // column's order: latest activity last, so the beam's first card is the one drawn highest.
  const news = messageNews(agentMessages(asked), [...both, said("agent", 4, answer("main"))]);

  assert.deepEqual(news.cards, ["t2", "t1", "main@2025-01-01T00:04:00.000Z"]);
  assert.equal(news.seen.size, 4);
});
