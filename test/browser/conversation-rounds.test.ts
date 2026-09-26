import { test } from "node:test";
import assert from "node:assert/strict";
import { currentRound, roundOf } from "../../src/browser/conversation-rounds.ts";
import type { RoundMark } from "../../src/session-store.ts";

const rounds: RoundMark[] = [
  { index: 0, at: "2025-01-01T00:00:00.000Z" },
  { index: 1, at: "2025-01-02T00:00:00.000Z" },
  { index: 2, at: "2025-01-03T00:00:00.000Z" },
];

test("the round on screen is the last one opened, and the first when none arrived", () => {
  assert.equal(currentRound(rounds), 2);
  assert.equal(currentRound([]), 0);
});

test("a stamped entry belongs to the round it was stamped with, whatever its clock says", () => {
  assert.equal(roundOf({ at: "2025-01-03T06:00:00.000Z", roundIndex: 0 }, rounds), 0);
});

test("an unstamped entry is placed by its clock, against the round that was open then", () => {
  // Sessions on disk from before the stamp: a round's `at` is when it opened,
  // so the last round that had opened when the entry was written owns it.
  assert.equal(roundOf({ at: "2025-01-01T06:00:00.000Z" }, rounds), 0);
  assert.equal(roundOf({ at: "2025-01-03T06:00:00.000Z" }, rounds), 2);
});

test("an entry older than every round belongs to the first one, not to no round", () => {
  assert.equal(roundOf({ at: "2024-12-31T00:00:00.000Z" }, rounds), 0);
  assert.equal(roundOf({ at: "2025-01-01T01:00:00.000Z" }, []), 0);
});

test("an unstamped entry sharing a round's own instant stays with the round before", () => {
  // Entry and round are stamped from different clock reads: sharing a millisecond is not
  // evidence the entry came after, and it is about the older round's diff.
  assert.equal(roundOf({ at: "2025-01-02T00:00:00.000Z" }, rounds), 0);
});
