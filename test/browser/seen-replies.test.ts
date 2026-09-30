import { test } from "node:test";
import assert from "node:assert/strict";
import { readMemory, SEEN_REPLY_LIMIT, updateMemory } from "../../src/browser/review-memory.ts";
import { trackSeenReplies, type SeenReplies } from "../../src/browser/seen-replies.ts";
import { FakeStorage } from "./fake-storage.ts";

const KEY = "abc123";

/** A draw in front of the reviewer: tab on screen, panel open. */
function show(seen: SeenReplies, said: string[], round: number): void {
  seen.drawn(new Set(said), round);
  seen.shown();
}

test("before a round's talk is drawn, everything the panel drew so far counts as seen", () => {
  const seen = trackSeenReplies(new FakeStorage(), KEY);
  show(seen, ["t1 a"], 1);
  show(seen, ["t1 a", "t1 b"], 1);

  assert.deepEqual([...seen.before(2)], ["t1 a", "t1 b"]);
});

test("words first drawn with a round are not seen for that round's replay", () => {
  // The round jump opens the replay after the panel has drawn the new round:
  // what came with it was under the jump, never in front of the reviewer.
  const seen = trackSeenReplies(new FakeStorage(), KEY);
  show(seen, ["t1 a"], 1);

  show(seen, ["t1 a", "t1 b"], 2);
  show(seen, ["t1 a", "t1 b", "t1 c"], 2);

  assert.deepEqual([...seen.before(2)], ["t1 a"], "asked after the draw: the same answer");
});

test("a round's talk drawn ahead of the round itself is not taken for seen before it", () => {
  // A feedback redraw can bring the next round's conversation before the page
  // takes the round: the answer for that round does not move.
  const seen = trackSeenReplies(new FakeStorage(), KEY);
  show(seen, ["t1 a"], 1);
  const asked = seen.before(2);

  show(seen, ["t1 a", "t1 b"], 2);

  assert.deepEqual([...asked], ["t1 a"]);
  assert.deepEqual([...seen.before(2)], ["t1 a"]);
});

test("what the panel drew is stored, so a reload still knows it was seen", () => {
  const storage = new FakeStorage();
  show(trackSeenReplies(storage, KEY), ["t1 a", "t1 b"], 1);

  const reloaded = trackSeenReplies(storage, KEY);
  // The reload's own first draw is of this round: what it brings anew is not seen yet.
  show(reloaded, ["t1 a", "t1 b", "t1 c"], 2);

  assert.deepEqual([...reloaded.before(2)], ["t1 a", "t1 b"]);
  assert.deepEqual(readMemory(storage, KEY).seen, ["t1 a", "t1 b", "t1 c"]);
});

test("a reload inside the round takes what an earlier load of it drew as seen", () => {
  const storage = new FakeStorage();
  show(trackSeenReplies(storage, KEY), ["t1 a", "t1 b"], 2);

  const reloaded = trackSeenReplies(storage, KEY);
  show(reloaded, ["t1 a", "t1 b"], 2);

  assert.deepEqual([...reloaded.before(2)], ["t1 a", "t1 b"]);
});

test("another tab's seen words are kept when this one stores its own", () => {
  const storage = new FakeStorage();
  const here = trackSeenReplies(storage, KEY);
  updateMemory(storage, KEY, { seen: ["t9 x"] });

  show(here, ["t1 a"], 1);

  assert.deepEqual(readMemory(storage, KEY).seen, ["t1 a", "t9 x"], "kept by when they were said");
});

test("a draw with nothing new writes nothing", () => {
  const storage = new FakeStorage();
  const seen = trackSeenReplies(storage, KEY);
  show(seen, [], 0);

  assert.equal(storage.getItem(`lsr:memory:${KEY}`), null);
});

test("with nothing drawn yet, the stored words are all that is seen", () => {
  const storage = new FakeStorage();
  updateMemory(storage, KEY, { seen: ["t1 a"] });

  assert.deepEqual([...trackSeenReplies(storage, KEY).before(3)], ["t1 a"]);
});

test("words drawn while not in front of the reviewer are not seen until they are", () => {
  const storage = new FakeStorage();
  const seen = trackSeenReplies(storage, KEY);
  seen.drawn(new Set(["t1 a"]), 1);

  assert.deepEqual([...seen.before(2)], [], "a hidden tab or shut panel showed nothing");
  assert.deepEqual(readMemory(storage, KEY).seen, []);

  seen.shown();
  assert.deepEqual(readMemory(storage, KEY).seen, ["t1 a"], "shown when the reviewer looks");
});

test("words shown after a round was asked for do not move that round's answer", () => {
  // A shut panel opened as the round lands shows the old words then: the
  // replay was asked for already, and every later ask must agree with it.
  const seen = trackSeenReplies(new FakeStorage(), KEY);
  show(seen, ["t1 a"], 1);
  seen.drawn(new Set(["t1 a", "t1 b"]), 1);
  const asked = seen.before(2);

  seen.shown();
  show(seen, ["t1 a", "t1 b", "t1 c"], 2);

  assert.deepEqual([...asked], ["t1 a"]);
  assert.deepEqual([...seen.before(2)], ["t1 a"]);
});

/** `count` messages a minute apart, each on its own card: `c0` said first. */
function saidInOrder(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `c${index} ${new Date(Date.UTC(2025, 0, 1) + index * 60_000).toISOString()}`,
  );
}

test("past the cap the oldest said go first, whatever order the panel drew them in", () => {
  const storage = new FakeStorage();
  const said = saidInOrder(SEEN_REPLY_LIMIT + 5);
  // The panel draws by group, not by time: the newest may come first.
  show(trackSeenReplies(storage, KEY), [...said].reverse(), 1);

  assert.deepEqual(readMemory(storage, KEY).seen, said.slice(5), "the newest kept, oldest first");
});

test("a reload that shows what is already kept, or older, writes nothing", () => {
  const storage = new FakeStorage();
  const said = saidInOrder(SEEN_REPLY_LIMIT + 5);
  show(trackSeenReplies(storage, KEY), said, 1);
  const writes: string[] = [];
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes.push(key);
    setItem(key, value);
  };

  // The five the cap let go come back as unknown to the reloaded page.
  show(trackSeenReplies(storage, KEY), [...said].reverse(), 1);

  assert.deepEqual(writes, []);
  assert.deepEqual(readMemory(storage, KEY).seen, said.slice(5));
});
