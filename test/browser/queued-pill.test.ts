import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stalePillRound,
  tallyOf,
  queuedTotal,
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

test("a general comment is never called stale: it has no lines to fall out of line", () => {
  // The badge warns that an anchor may point at the wrong lines; a message has no anchor, and
  // a general comment queued on the agent's turn outliving the round is the ordinary case.
  assert.equal(
    stalePillRound({ type: "message", comment: "and the tests", round: 1 }, 3),
    undefined,
  );
});

test("a queued reply or resolve is never called stale: it names a thread, not lines", () => {
  // Threads outlive rounds; a reply queued through the agent's turn is the ordinary case.
  assert.equal(
    stalePillRound({ type: "reply", thread: "t1", comment: "ok", round: 1 }, 3),
    undefined,
  );
  assert.equal(
    stalePillRound({ type: "resolve", thread: "t1", resolved: true, round: 1 }, 3),
    undefined,
  );
});

test("the tally counts line and general comments as comments, apart from replies and resolves", () => {
  const tally = tallyOf([
    annotation,
    { type: "message", comment: "and the tests" },
    { type: "reply", thread: "t1", comment: "ok" },
    { type: "resolve", thread: "t2", resolved: true },
    { type: "resolve", thread: "t3", resolved: false },
  ]);

  assert.deepEqual(tally, { comments: 2, replies: 1, resolves: 2 });
  assert.equal(queuedTotal(tally), 5);
});
