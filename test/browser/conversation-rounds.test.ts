import { test } from "node:test";
import assert from "node:assert/strict";
import { roundSegments } from "../../src/browser/conversation-rounds.ts";
import type { ConversationEntry, RoundMark } from "../../src/session-store.ts";

function entry(at: string, over: Partial<ConversationEntry> = {}): ConversationEntry {
  return { role: "reviewer", at, prompts: [{ type: "message", comment: at }], ...over };
}

const rounds: RoundMark[] = [
  { index: 0, at: "2025-01-01T00:00:00.000Z" },
  { index: 1, at: "2025-01-02T00:00:00.000Z" },
  { index: 2, at: "2025-01-03T00:00:00.000Z" },
];

/** What each segment claims, which is all these tests are about. */
function shape(segments: ReturnType<typeof roundSegments>) {
  return segments.map(({ round, current, entries }) => ({
    round,
    current,
    said: entries.map((one) => one.at),
  }));
}

test("a review that has only ever had one round is one segment, and it is the live one", () => {
  const segments = roundSegments(
    [entry("2025-01-01T01:00:00.000Z", { roundIndex: 0 })],
    [rounds[0]!],
  );

  assert.deepEqual(
    segments.map(({ round, current, entries }) => ({ round, current, said: entries.length })),
    [{ round: 0, current: true, said: 1 }],
  );
});

test("entries are split where the round they were stamped with changes", () => {
  const segments = roundSegments(
    [
      entry("2025-01-01T01:00:00.000Z", { roundIndex: 0 }),
      entry("2025-01-01T02:00:00.000Z", { roundIndex: 0, role: "agent" }),
      entry("2025-01-02T01:00:00.000Z", { roundIndex: 1 }),
    ],
    rounds.slice(0, 2),
  );

  assert.deepEqual(
    segments.map(({ round, current, entries }) => ({ round, current, said: entries.length })),
    [
      { round: 0, current: false, said: 2 },
      { round: 1, current: true, said: 1 },
    ],
  );
});

test("a round that comes round again is a second segment, not the first one reopened", () => {
  // Grouped by adjacency, so the stream keeps its said order; a map keyed by round would hoist
  // the third entry into the first segment — history reordered.
  const segments = roundSegments(
    [
      entry("2025-01-01T01:00:00.000Z", { roundIndex: 0 }),
      entry("2025-01-02T01:00:00.000Z", { roundIndex: 1 }),
      entry("2025-01-02T02:00:00.000Z", { roundIndex: 0 }),
    ],
    rounds.slice(0, 2),
  );

  assert.deepEqual(shape(segments), [
    { round: 0, current: false, said: ["2025-01-01T01:00:00.000Z"] },
    { round: 1, current: true, said: ["2025-01-02T01:00:00.000Z"] },
    { round: 0, current: false, said: ["2025-01-02T02:00:00.000Z"] },
    { round: 1, current: true, said: [] },
  ]);
});

test("an unstamped entry is placed by its clock, against the round that was open then", () => {
  // Sessions on disk from before the stamp: a round's `at` is when it opened,
  // so the last round that had opened when the entry was written owns it.
  const segments = roundSegments(
    [entry("2025-01-01T06:00:00.000Z"), entry("2025-01-03T06:00:00.000Z")],
    rounds,
  );

  assert.deepEqual(
    segments.map(({ round, entries }) => ({ round, said: entries.length })),
    [
      { round: 0, said: 1 },
      { round: 2, said: 1 },
    ],
  );
});

test("a session part-way through the change reads its old and new entries alike", () => {
  // The shape every session file on disk takes the moment stamping shipped:
  // everything already written is unstamped, everything after it is stamped.
  const segments = roundSegments(
    [
      entry("2025-01-01T06:00:00.000Z"),
      entry("2025-01-02T06:00:00.000Z"),
      entry("2025-01-03T06:00:00.000Z", { roundIndex: 2 }),
    ],
    rounds,
  );

  assert.deepEqual(shape(segments), [
    { round: 0, current: false, said: ["2025-01-01T06:00:00.000Z"] },
    { round: 1, current: false, said: ["2025-01-02T06:00:00.000Z"] },
    { round: 2, current: true, said: ["2025-01-03T06:00:00.000Z"] },
  ]);
});

test("an entry older than every round belongs to the first one, not to no round", () => {
  const segments = roundSegments([entry("2024-12-31T00:00:00.000Z")], rounds);

  assert.deepEqual(segments[0]?.round, 0);
});

test("an unstamped entry sharing a round's own instant stays with the round before", () => {
  // Entry and round are stamped from different clock reads: sharing a millisecond is not
  // evidence the entry came after, and it is about the older round's diff.
  const segments = roundSegments([entry("2025-01-02T00:00:00.000Z")], rounds);

  assert.deepEqual(segments[0]?.round, 0);
});

test("the round on screen is a segment of its own even before anything is said in it", () => {
  // This is the marker that answers "what is new": with a fresh round open and
  // no reply yet, everything above the last divider is the round before.
  const segments = roundSegments([entry("2025-01-01T01:00:00.000Z", { roundIndex: 0 })], rounds);

  assert.deepEqual(
    segments.map(({ round, current, entries }) => ({ round, current, said: entries.length })),
    [
      { round: 0, current: false, said: 1 },
      { round: 2, current: true, said: 0 },
    ],
  );
});

test("an empty conversation in a fresh review has nothing to divide", () => {
  assert.deepEqual(roundSegments([], [rounds[0]!]), []);
});

test("a session whose rounds never arrived still shows its conversation, undivided", () => {
  const segments = roundSegments([entry("2025-01-01T01:00:00.000Z")], []);

  assert.deepEqual(
    segments.map(({ round, current, entries }) => ({ round, current, said: entries.length })),
    [{ round: 0, current: true, said: 1 }],
  );
});
