import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stalePillRound,
  stampPills,
  unstampedPill,
  type QueuedPill,
} from "../../src/browser/queued-pill.ts";
import type { FeedbackPrompt } from "../../src/session-store.ts";

const annotation: FeedbackPrompt = {
  type: "annotation",
  file: "src/api.ts",
  group: "API",
  selected_text: "+const x = 1;",
  comment: "this name says nothing",
  side: "new",
  line_start: 12,
  line_end: 14,
};

test("stamping marks every prompt with the round it was queued in", () => {
  const pills = stampPills([annotation, { type: "message", comment: "hi" }], 2);

  assert.deepEqual(pills, [
    { ...annotation, round: 2 },
    { type: "message", comment: "hi", round: 2 },
  ]);
});

test("unstamping gives back exactly the prompt the wire expects", () => {
  const pill: QueuedPill = { ...annotation, round: 3 };

  assert.deepEqual(unstampedPill(pill), annotation);
});

test("a pill that never carried a stamp is already the prompt itself", () => {
  assert.deepEqual(unstampedPill(annotation), annotation);
});

test("a pill still in the round it was queued in is not stale", () => {
  assert.equal(stalePillRound({ ...annotation, round: 1 }, 1), undefined);
});

test("a pill that outlived its round says which round it was queued in", () => {
  assert.equal(stalePillRound({ ...annotation, round: 1 }, 3), 1);
});

test("a stamp from a round the session no longer names is stale too, not trusted", () => {
  // A round number ahead of the one on screen is a rewound session file, not a
  // reason to guess: the anchor still points into a diff that is not this one.
  assert.equal(stalePillRound({ ...annotation, round: 5 }, 3), 5);
});

test("a pill with no stamp at all is never called stale — absence is not a guess", () => {
  assert.equal(stalePillRound(annotation, 3), undefined);
});
