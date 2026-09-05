import { test } from "node:test";
import assert from "node:assert/strict";
import { crossings } from "../../src/browser/approval-crossing.ts";

/** A crossing counter, which is all there is to watch here. */
function watcher(): { report: (complete: boolean) => void; crossed: () => number } {
  let count = 0;
  return { report: crossings(() => (count += 1)), crossed: () => count };
}

test("a round that opens fully approved has not just crossed into it", () => {
  const { report, crossed } = watcher();

  report(true);

  assert.equal(crossed(), 0, "that is where the review started, not something that happened");
});

test("the report that finishes the last file is the crossing", () => {
  const { report, crossed } = watcher();
  report(false);

  report(true);

  assert.equal(crossed(), 1);
});

test("a review that stays approved crosses once and then says nothing", () => {
  const { report, crossed } = watcher();
  report(false);
  report(true);

  report(true);
  report(true);

  assert.equal(crossed(), 1, "a redraw is not a second crossing");
});

test("unticking a file and ticking it again crosses again", () => {
  const { report, crossed } = watcher();
  report(false);
  report(true);

  report(false);
  report(true);

  assert.equal(crossed(), 2, "the reviewer went back to a file and finished again");
});

test("a review nobody has finished never crosses", () => {
  const { report, crossed } = watcher();

  report(false);
  report(false);

  assert.equal(crossed(), 0);
});
