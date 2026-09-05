import { test } from "node:test";
import assert from "node:assert/strict";
import { tickCollapsePlan } from "../../src/browser/collapse-plan.ts";

test("a tick that finished one file shuts that file and holds its header still", () => {
  const plan = tickCollapsePlan([{ path: "a.ts", approved: true }], []);

  assert.deepEqual(plan.steps, [
    { target: { kind: "file", path: "a.ts" }, expanded: false, animated: true },
  ]);
  assert.deepEqual(plan.anchor, { kind: "file", path: "a.ts" });
});

test("unticking a file opens it again, and it is still what must not move", () => {
  const plan = tickCollapsePlan([{ path: "a.ts", approved: false }], []);

  assert.deepEqual(plan.steps, [
    { target: { kind: "file", path: "a.ts" }, expanded: true, animated: true },
  ]);
  assert.deepEqual(plan.anchor, { kind: "file", path: "a.ts" });
});

test("the tick that finishes a group holds the group, which is what survives it", () => {
  // The file's own header goes down with the group that is shutting over it, so
  // it is no landmark: the group's header is the only thing left in place.
  const plan = tickCollapsePlan([{ path: "b.ts", approved: true }], [{ index: 2, approved: true }]);

  assert.deepEqual(plan.anchor, { kind: "group", index: 2 });
});

test("that tick is one movement: the group folds and the file inside it does not", () => {
  const plan = tickCollapsePlan([{ path: "b.ts", approved: true }], [{ index: 2, approved: true }]);

  assert.deepEqual(plan.steps, [
    { target: { kind: "file", path: "b.ts" }, expanded: false, animated: false },
    { target: { kind: "group", index: 2 }, expanded: false, animated: true },
  ]);
});

test("the files of a group ticked whole are set before the group folds over them", () => {
  // Otherwise the group animates towards a height its files are about to change.
  const plan = tickCollapsePlan(
    [
      { path: "a.ts", approved: true },
      { path: "b.ts", approved: true },
    ],
    [{ index: 0, approved: true }],
  );

  assert.deepEqual(
    plan.steps.map((step) => step.target),
    [
      { kind: "file", path: "a.ts" },
      { kind: "file", path: "b.ts" },
      { kind: "group", index: 0 },
    ],
  );
});

test("several files and no group leaves the first of them as the anchor", () => {
  const plan = tickCollapsePlan(
    [
      { path: "a.ts", approved: true },
      { path: "b.ts", approved: true },
    ],
    [],
  );

  assert.deepEqual(plan.anchor, { kind: "file", path: "a.ts" });
  assert.deepEqual(
    plan.steps.map((step) => step.animated),
    [true, true],
  );
});

test("a tick that opened and shut nothing has nothing to hold", () => {
  const plan = tickCollapsePlan([], []);

  assert.deepEqual(plan.steps, []);
  assert.equal(plan.anchor, undefined);
});
