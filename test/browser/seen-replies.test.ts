import { test } from "node:test";
import assert from "node:assert/strict";
import { readMemory, updateMemory } from "../../src/browser/review-memory.ts";
import { trackSeenReplies } from "../../src/browser/seen-replies.ts";
import { FakeStorage } from "./fake-storage.ts";

const KEY = "abc123";

test("before a round's talk is drawn, everything the panel drew so far counts as seen", () => {
  const seen = trackSeenReplies(new FakeStorage(), KEY);
  seen.drawn(new Set(["t1 a"]), 1);
  seen.drawn(new Set(["t1 a", "t1 b"]), 1);

  assert.deepEqual([...seen.before(2)], ["t1 a", "t1 b"]);
});

test("words first drawn with a round are not seen for that round's replay", () => {
  // The round jump opens the replay after the panel has drawn the new round:
  // what came with it was under the jump, never in front of the reviewer.
  const seen = trackSeenReplies(new FakeStorage(), KEY);
  seen.drawn(new Set(["t1 a"]), 1);

  seen.drawn(new Set(["t1 a", "t1 b"]), 2);
  seen.drawn(new Set(["t1 a", "t1 b", "t1 c"]), 2);

  assert.deepEqual([...seen.before(2)], ["t1 a"], "asked after the draw: the same answer");
});

test("a round's talk drawn ahead of the round itself is not taken for seen before it", () => {
  // A feedback redraw can bring the next round's conversation before the page
  // takes the round: the answer for that round does not move.
  const seen = trackSeenReplies(new FakeStorage(), KEY);
  seen.drawn(new Set(["t1 a"]), 1);
  const asked = seen.before(2);

  seen.drawn(new Set(["t1 a", "t1 b"]), 2);

  assert.deepEqual([...asked], ["t1 a"]);
  assert.deepEqual([...seen.before(2)], ["t1 a"]);
});

test("what the panel drew is stored, so a reload still knows it was seen", () => {
  const storage = new FakeStorage();
  trackSeenReplies(storage, KEY).drawn(new Set(["t1 a", "t1 b"]), 1);

  const reloaded = trackSeenReplies(storage, KEY);
  // The reload's own first draw is of this round: what it brings anew is not seen yet.
  reloaded.drawn(new Set(["t1 a", "t1 b", "t1 c"]), 2);

  assert.deepEqual([...reloaded.before(2)], ["t1 a", "t1 b"]);
  assert.deepEqual(readMemory(storage, KEY).seen, ["t1 a", "t1 b", "t1 c"]);
});

test("a reload inside the round takes what an earlier load of it drew as seen", () => {
  const storage = new FakeStorage();
  trackSeenReplies(storage, KEY).drawn(new Set(["t1 a", "t1 b"]), 2);

  const reloaded = trackSeenReplies(storage, KEY);
  reloaded.drawn(new Set(["t1 a", "t1 b"]), 2);

  assert.deepEqual([...reloaded.before(2)], ["t1 a", "t1 b"]);
});

test("another tab's seen words are kept when this one stores its own", () => {
  const storage = new FakeStorage();
  const here = trackSeenReplies(storage, KEY);
  updateMemory(storage, KEY, { seen: ["t9 x"] });

  here.drawn(new Set(["t1 a"]), 1);

  assert.deepEqual(readMemory(storage, KEY).seen, ["t9 x", "t1 a"]);
});

test("a draw with nothing new writes nothing", () => {
  const storage = new FakeStorage();
  const seen = trackSeenReplies(storage, KEY);
  seen.drawn(new Set(), 0);

  assert.equal(storage.getItem(`lsr:memory:${KEY}`), null);
});

test("with nothing drawn yet, the stored words are all that is seen", () => {
  const storage = new FakeStorage();
  updateMemory(storage, KEY, { seen: ["t1 a"] });

  assert.deepEqual([...trackSeenReplies(storage, KEY).before(3)], ["t1 a"]);
});
