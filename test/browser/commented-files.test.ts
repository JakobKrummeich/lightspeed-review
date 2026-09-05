import { test } from "node:test";
import assert from "node:assert/strict";
import { commentedLastRound, commentedOn } from "../../src/browser/commented-files.ts";
import type { DiffFile } from "../../src/diff-extract.ts";
import type { ConversationEntry, FeedbackPrompt, RoundMark } from "../../src/session-store.ts";

const rounds: RoundMark[] = [
  { index: 0, at: "2025-01-01T00:00:00.000Z" },
  { index: 1, at: "2025-01-02T00:00:00.000Z" },
  { index: 2, at: "2025-01-03T00:00:00.000Z" },
];

function annotation(file: string): FeedbackPrompt {
  return { type: "annotation", file, group: "API", selected_text: "old", comment: `about ${file}` };
}

function said(at: string, prompts: FeedbackPrompt[], over: Partial<ConversationEntry> = {}) {
  return { role: "reviewer", at, prompts, ...over } satisfies ConversationEntry;
}

function file(path: string, previousPath?: string): DiffFile {
  return {
    path,
    previousPath,
    status: previousPath === undefined ? "modified" : "renamed",
    diff: "",
    insertions: 0,
    deletions: 0,
    oversized: false,
  };
}

test("the files the reviewer annotated in the round before this one are the marked ones", () => {
  const paths = commentedLastRound(
    [
      said("2025-01-02T01:00:00.000Z", [annotation("src/api.ts")], { roundIndex: 1 }),
      said("2025-01-02T02:00:00.000Z", [annotation("src/db.ts")], { roundIndex: 1 }),
    ],
    rounds,
  );

  assert.deepEqual([...paths].sort(), ["src/api.ts", "src/db.ts"]);
});

test("what was said about the diff on screen is not last round's feedback", () => {
  const paths = commentedLastRound(
    [said("2025-01-03T01:00:00.000Z", [annotation("src/api.ts")], { roundIndex: 2 })],
    rounds,
  );

  assert.deepEqual([...paths], []);
});

test("feedback from before the round that has just been answered is old news", () => {
  const paths = commentedLastRound(
    [
      said("2025-01-01T01:00:00.000Z", [annotation("src/old.ts")], { roundIndex: 0 }),
      said("2025-01-02T01:00:00.000Z", [annotation("src/api.ts")], { roundIndex: 1 }),
    ],
    rounds,
  );

  assert.deepEqual([...paths], ["src/api.ts"]);
});

test("the first round of a review has no round behind it to have commented in", () => {
  const paths = commentedLastRound(
    [said("2025-01-01T01:00:00.000Z", [annotation("src/api.ts")], { roundIndex: 0 })],
    [rounds[0]!],
  );

  assert.deepEqual([...paths], []);
});

test("only what the reviewer said counts; the agent's replies name no files of theirs", () => {
  const paths = commentedLastRound(
    [
      said("2025-01-02T01:00:00.000Z", [annotation("src/agent.ts")], {
        roundIndex: 1,
        role: "agent",
      }),
    ],
    rounds,
  );

  assert.deepEqual([...paths], []);
});

test("a general message names no file, so it marks none", () => {
  const paths = commentedLastRound(
    [
      said("2025-01-02T01:00:00.000Z", [{ type: "message", comment: "looks close" }], {
        roundIndex: 1,
      }),
      said("2025-01-02T02:00:00.000Z", [annotation("src/api.ts")], { roundIndex: 1 }),
    ],
    rounds,
  );

  assert.deepEqual([...paths], ["src/api.ts"]);
});

test("an unstamped entry is placed the way the conversation panel places it", () => {
  // Sessions written before the round stamp existed: the last round that had
  // opened when the entry was written owns it, which is the panel's rule.
  const paths = commentedLastRound(
    [said("2025-01-02T06:00:00.000Z", [annotation("src/api.ts")])],
    [...rounds],
  );

  assert.deepEqual([...paths], ["src/api.ts"]);
});

test("a file annotated twice is one file", () => {
  const paths = commentedLastRound(
    [
      said("2025-01-02T01:00:00.000Z", [annotation("src/api.ts"), annotation("src/api.ts")], {
        roundIndex: 1,
      }),
    ],
    rounds,
  );

  assert.deepEqual([...paths], ["src/api.ts"]);
});

test("a review with no rounds at all has nothing before what it is showing", () => {
  assert.deepEqual([...commentedLastRound([said("2025-01-02T01:00:00.000Z", [])], [])], []);
});

test("a file matches the comment left on the name it had then", () => {
  const paths = new Set(["src/api.ts"]);

  assert.equal(commentedOn(file("src/api.ts"), paths), true);
  assert.equal(commentedOn(file("src/other.ts"), paths), false);
});

test("a file renamed since the comment was left is still the file it was left on", () => {
  // The annotation carries the path as last round's diff named it, and this
  // round's diff names the same file something else.
  const paths = new Set(["src/api.ts"]);

  assert.equal(commentedOn(file("src/http/api.ts", "src/api.ts"), paths), true);
});
