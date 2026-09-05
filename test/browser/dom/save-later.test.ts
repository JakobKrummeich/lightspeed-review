import { test } from "node:test";
import assert from "node:assert/strict";
import { SAVE_DELAY_MS, saveLater } from "../../../src/browser/dom/save-later.ts";

/** Long enough to tell "waiting" from "gone", short enough to spend in a test. */
const DELAY = 20;

const after = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A write that counts itself, and says what it was handed each time. */
function counted(): { runs: () => number; write: () => void } {
  let runs = 0;
  return { runs: () => runs, write: () => void (runs += 1) };
}

test("a burst of asks is one write, made after the burst stops", async () => {
  const { runs, write } = counted();
  const save = saveLater(write, DELAY);

  save.soon();
  save.soon();
  save.soon();
  assert.equal(runs(), 0, "nothing is written while the reviewer is still going");

  await after(DELAY * 3);
  assert.equal(runs(), 1, "the asks collapsed into the last one");
});

test("an ask made while one is waiting pushes the write back", async () => {
  const { runs, write } = counted();
  const save = saveLater(write, DELAY);

  save.soon();
  await after(DELAY * 0.6);
  save.soon();
  await after(DELAY * 0.6);

  assert.equal(runs(), 0, "the first ask was replaced, not merely joined");
  await after(DELAY);
  assert.equal(runs(), 1);
});

test("a waiting write can be made to happen at once", async () => {
  const { runs, write } = counted();
  const save = saveLater(write, DELAY);

  save.soon();
  save.now();

  assert.equal(runs(), 1, "the tab is going away; the wait would cost the reviewer the write");
  await after(DELAY * 3);
  assert.equal(runs(), 1, "and the write it was waiting on does not happen twice");
});

test("nothing waiting means nothing to write", async () => {
  const { runs, write } = counted();
  const save = saveLater(write, DELAY);

  save.now();

  assert.equal(runs(), 0, "a page being hidden is not itself news");
  await after(DELAY * 3);
  assert.equal(runs(), 0);
});

test("a write asked for and then made and then asked for again is two writes", async () => {
  const { runs, write } = counted();
  const save = saveLater(write, DELAY);

  save.soon();
  save.now();
  save.soon();
  await after(DELAY * 3);

  assert.equal(runs(), 2, "the reviewer went on typing after the tab came back");
});

test("the delay reviewers actually get is long enough to hold a burst", async () => {
  const { runs, write } = counted();
  const save = saveLater(write);

  save.soon();
  await after(0);

  assert.equal(runs(), 0, "a keystroke is not a write");
  assert.ok(SAVE_DELAY_MS >= 100, `${SAVE_DELAY_MS}ms would write on nearly every keystroke`);
  assert.ok(SAVE_DELAY_MS <= 1000, `${SAVE_DELAY_MS}ms is long enough for a reader to leave`);
});
