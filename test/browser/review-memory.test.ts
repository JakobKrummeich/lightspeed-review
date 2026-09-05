import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MEMORY_SESSION_LIMIT,
  readMemory,
  reviewPlace,
  updateMemory,
  type ReviewMemoryStorage,
} from "../../src/browser/review-memory.ts";
import type { AnnotationPrompt, FeedbackPrompt } from "../../src/session-store.ts";
import { FakeStorage } from "./fake-storage.ts";

/** A store that answers nothing at all, as a browser with cookies off does. */
const blocked: ReviewMemoryStorage = {
  get length(): number {
    throw new Error("storage disabled");
  },
  key: () => {
    throw new Error("storage disabled");
  },
  getItem: () => {
    throw new Error("storage disabled");
  },
  setItem: () => {
    throw new Error("storage disabled");
  },
  removeItem: () => {
    throw new Error("storage disabled");
  },
};

const annotation: AnnotationPrompt = {
  type: "annotation",
  file: "src/api.ts",
  group: "API",
  selected_text: "+const x = 1;",
  comment: "this name says nothing",
  side: "new",
  line_start: 12,
  line_end: 14,
  col_start: 3,
  col_end: 9,
};

/** What is stored under one review, as JSON, so a test can look at the record. */
function record(storage: FakeStorage, sessionKey: string): Record<string, unknown> {
  const text = storage.getItem(`lsr:memory:${sessionKey}`);
  assert.ok(text, `${sessionKey} was stored`);
  return JSON.parse(text) as Record<string, unknown>;
}

test("a review nobody has touched remembers nothing", () => {
  const memory = readMemory(new FakeStorage(), "abc123");

  assert.deepEqual(memory, {
    pending: [],
    draft: "",
    round: undefined,
    replayed: undefined,
    unwrapped: false,
    groups: [],
    files: [],
    scroll: 0,
    focus: undefined,
  });
});

test("a queued annotation comes back with the context it would have been sent with", () => {
  const storage = new FakeStorage();

  updateMemory(storage, "abc123", { pending: [annotation, { type: "message", comment: "hi" }] });

  assert.deepEqual(readMemory(storage, "abc123").pending, [
    annotation,
    { type: "message", comment: "hi" },
  ]);
});

test("the queue keeps the order the reviewer queued it in", () => {
  const storage = new FakeStorage();
  const pending = ["one", "two", "three"].map((comment) => ({ ...annotation, comment }));

  updateMemory(storage, "abc123", { pending });

  assert.deepEqual(
    readMemory(storage, "abc123").pending.map((prompt) => prompt.comment),
    ["one", "two", "three"],
  );
});

test("another review's queue is not this one's", () => {
  const storage = new FakeStorage();

  updateMemory(storage, "abc123", { pending: [annotation] });

  assert.deepEqual(readMemory(storage, "def456").pending, []);
});

test("a patch leaves the fields it does not name alone", () => {
  const storage = new FakeStorage();
  updateMemory(storage, "abc123", { pending: [annotation] });

  updateMemory(storage, "abc123", { draft: "one more thing" });

  const memory = readMemory(storage, "abc123");
  assert.equal(memory.draft, "one more thing");
  assert.deepEqual(memory.pending, [annotation]);
});

test("sending the queue takes the review's record away with it", () => {
  const storage = new FakeStorage();
  updateMemory(storage, "abc123", { pending: [annotation], draft: "typed" });

  updateMemory(storage, "abc123", { pending: [], draft: "" });

  assert.equal(storage.getItem("lsr:memory:abc123"), null, "nothing is left to clean up");
});

test("where the reviewer was reading comes back in the round they read it in", () => {
  const storage = new FakeStorage();

  updateMemory(storage, "abc123", { round: 2, groups: [0, 3], files: ["src/api.ts"], scroll: 940 });

  assert.deepEqual(reviewPlace(readMemory(storage, "abc123"), 2), {
    groups: [0, 3],
    files: ["src/api.ts"],
    scroll: 940,
    focus: undefined,
  });
});

test("a later round is not put back where the round before it was", () => {
  const storage = new FakeStorage();
  updateMemory(storage, "abc123", { round: 2, groups: [0], files: ["src/api.ts"], scroll: 940 });

  assert.equal(reviewPlace(readMemory(storage, "abc123"), 3), undefined);
});

test("a new round drops the paths of the diff it replaced", () => {
  const storage = new FakeStorage();
  updateMemory(storage, "abc123", { round: 2, groups: [0], files: ["gone.ts"], scroll: 940 });

  updateMemory(storage, "abc123", { round: 3, groups: [1] });

  const memory = readMemory(storage, "abc123");
  assert.deepEqual(memory.files, [], "no file of the old grouping is still remembered");
  assert.equal(memory.scroll, 0);
  assert.deepEqual(reviewPlace(memory, 3), { groups: [1], files: [], scroll: 0, focus: undefined });
});

test("a new round carries the unsent work across, the way the open page does", () => {
  const storage = new FakeStorage();
  updateMemory(storage, "abc123", { round: 2, pending: [annotation], draft: "halfway" });

  updateMemory(storage, "abc123", { round: 3, groups: [], files: [], scroll: 0 });

  const memory = readMemory(storage, "abc123");
  assert.deepEqual(memory.pending, [annotation]);
  assert.equal(memory.draft, "halfway");
});

test("a record from an older version of the page is ignored, not guessed at", () => {
  const storage = new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({ v: 0, pending: [annotation], draft: "old" }),
  });

  assert.deepEqual(readMemory(storage, "abc123").pending, []);
  assert.equal(readMemory(storage, "abc123").draft, "");
});

test("a record that is not JSON at all does not break the page", () => {
  const storage = new FakeStorage({ "lsr:memory:abc123": "{not json" });

  assert.doesNotThrow(() => readMemory(storage, "abc123"));
  assert.deepEqual(readMemory(storage, "abc123").pending, []);
});

test("a record of the wrong shape is read as the empty one", () => {
  const storage = new FakeStorage({ "lsr:memory:abc123": JSON.stringify(["v", 1]) });

  assert.deepEqual(readMemory(storage, "abc123").files, []);
});

test("fields stored as the wrong type fall back rather than travel", () => {
  const storage = new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({
      v: 1,
      pending: "everything",
      draft: 42,
      round: "two",
      groups: [0, "one", 2.5],
      files: ["src/api.ts", 7],
      scroll: "far",
    }),
  });

  assert.deepEqual(readMemory(storage, "abc123"), {
    pending: [],
    draft: "",
    round: undefined,
    replayed: undefined,
    unwrapped: false,
    groups: [0],
    files: ["src/api.ts"],
    scroll: 0,
    focus: undefined,
  });
});

test("a queued pill missing the file it was about is dropped, and the rest are kept", () => {
  const storage = new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({
      v: 1,
      pending: [
        { type: "annotation", group: "API", selected_text: "+x", comment: "no file" },
        {
          type: "annotation",
          file: "src/api.ts",
          group: "API",
          selected_text: "+x",
          comment: "ok",
        },
        { type: "message" },
        { type: "shout", comment: "unknown" },
      ],
    }),
  });

  assert.deepEqual(readMemory(storage, "abc123").pending, [
    { type: "annotation", file: "src/api.ts", group: "API", selected_text: "+x", comment: "ok" },
  ]);
});

test("half an anchor sends the annotation unanchored rather than at the wrong lines", () => {
  const storage = new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({
      v: 1,
      pending: [
        {
          type: "annotation",
          file: "src/api.ts",
          group: "API",
          selected_text: "+x",
          comment: "half",
          side: "new",
          line_start: 12,
        },
      ],
    }),
  });

  assert.deepEqual(readMemory(storage, "abc123").pending, [
    { type: "annotation", file: "src/api.ts", group: "API", selected_text: "+x", comment: "half" },
  ]);
});

/** The stored shape of one queued annotation, with a field spoiled per case. */
function storedPill(spoiled: Record<string, unknown>): FakeStorage {
  return new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({
      v: 1,
      pending: [
        {
          type: "annotation",
          file: "src/api.ts",
          group: "API",
          selected_text: "+x",
          comment: "about this",
          ...spoiled,
        },
      ],
    }),
  });
}

/** What a whole record of `storedPill` restores as, anchor and all. */
function restoredPill(spoiled: Record<string, unknown>): FeedbackPrompt | undefined {
  return readMemory(storedPill(spoiled), "abc123").pending.at(0);
}

// The agent is shown file, group and selected text: a record missing one names something the
// agent cannot go and read.
for (const missing of ["group", "selected_text"]) {
  test(`a queued pill with no ${missing} is dropped rather than sent incomplete`, () => {
    assert.equal(restoredPill({ [missing]: undefined }), undefined);
  });

  test(`a queued pill whose ${missing} is not text is dropped`, () => {
    assert.equal(restoredPill({ [missing]: 7 }), undefined);
  });
}

// The server refuses the whole payload over an invalid anchor: restoring one would hand the
// reviewer a queue that can never be sent, so the anchor goes and the words stay.
const impossible: Record<string, Record<string, unknown>> = {
  "a line number of zero": { line_start: 0, line_end: 4 },
  "a negative line number": { line_start: -2, line_end: -1 },
  "a range that runs backwards": { line_start: 9, line_end: 4 },
  "columns that run backwards inside one line": {
    line_start: 4,
    line_end: 4,
    col_start: 9,
    col_end: 3,
  },
  "a column of zero": { line_start: 4, line_end: 5, col_start: 0 },
};

for (const [what, anchor] of Object.entries(impossible)) {
  test(`${what} is dropped, and the comment is still queued`, () => {
    assert.deepEqual(restoredPill({ side: "new", ...anchor }), {
      type: "annotation",
      file: "src/api.ts",
      group: "API",
      selected_text: "+x",
      comment: "about this",
    });
  });
}

test("a whole-line selection keeps carrying no columns", () => {
  const storage = new FakeStorage();
  const whole: AnnotationPrompt = {
    type: "annotation",
    file: "src/api.ts",
    group: "API",
    selected_text: "+x",
    comment: "whole lines",
    side: "old",
    line_start: 3,
    line_end: 4,
  };

  updateMemory(storage, "abc123", { pending: [whole] });

  assert.deepEqual(readMemory(storage, "abc123").pending, [whole]);
});

test("a pill's queue-round stamp survives the reload with it", () => {
  const storage = new FakeStorage();

  updateMemory(storage, "abc123", { pending: [{ ...annotation, round: 2 }] });

  assert.deepEqual(readMemory(storage, "abc123").pending, [{ ...annotation, round: 2 }]);
});

test("a pill stored before stamps existed restores without one, not with a guess", () => {
  const storage = new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({ v: 1, pending: [annotation] }),
  });

  assert.deepEqual(readMemory(storage, "abc123").pending, [annotation]);
});

// A stamp is the page's own note, never worth a pill: whatever spoiled it, the
// words are restored and the stamp alone is dropped — no badge, no guess.
for (const round of ["two", -1, 2.5]) {
  test(`a stamp of ${round} is corruption — dropped while the pill's words are kept`, () => {
    const storage: FakeStorage = new FakeStorage({
      "lsr:memory:abc123": JSON.stringify({ v: 1, pending: [{ ...annotation, round }] }),
    });

    assert.deepEqual(readMemory(storage, "abc123").pending, [annotation]);
  });
}

test("a broken anchor loses the anchor and keeps the stamp", () => {
  const storage = new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({
      v: 1,
      pending: [
        {
          type: "annotation",
          file: "src/api.ts",
          group: "API",
          selected_text: "+x",
          comment: "half",
          side: "new",
          line_start: 12,
          round: 1,
        },
      ],
    }),
  });

  assert.deepEqual(readMemory(storage, "abc123").pending, [
    {
      type: "annotation",
      file: "src/api.ts",
      group: "API",
      selected_text: "+x",
      comment: "half",
      round: 1,
    },
  ]);
});

test("a scroll offset stored as a negative number is read as the top", () => {
  const storage = new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({ v: 1, round: 0, scroll: -800 }),
  });

  assert.deepEqual(reviewPlace(readMemory(storage, "abc123"), 0)?.scroll, 0);
});

test("only so many reviews are remembered, and the oldest are the ones dropped", () => {
  const storage = new FakeStorage();

  for (let index = 0; index <= MEMORY_SESSION_LIMIT; index += 1) {
    updateMemory(storage, `session-${index}`, { draft: `note ${index}` });
  }

  const keys = [...storage.entries.keys()];
  assert.equal(keys.length, MEMORY_SESSION_LIMIT);
  assert.ok(!keys.includes("lsr:memory:session-0"), "the review written longest ago is gone");
  assert.ok(keys.includes(`lsr:memory:session-${MEMORY_SESSION_LIMIT}`), "the newest is kept");
});

test("records other than this store's are left where they are", () => {
  const storage = new FakeStorage({ "lsr:view-format:abc123": "side-by-side" });

  for (let index = 0; index <= MEMORY_SESSION_LIMIT; index += 1) {
    updateMemory(storage, `session-${index}`, { draft: `note ${index}` });
  }

  assert.equal(storage.getItem("lsr:view-format:abc123"), "side-by-side");
});

test("every write says when it happened, which is what eviction reads", () => {
  const storage = new FakeStorage();

  updateMemory(storage, "abc123", { draft: "typed" });

  assert.equal(typeof record(storage, "abc123").at, "number");
  assert.equal(record(storage, "abc123").v, 1);
});

test("a store that refuses to answer loses nothing but the memory", () => {
  assert.doesNotThrow(() => readMemory(blocked, "abc123"));
  assert.deepEqual(readMemory(blocked, "abc123").pending, []);
  assert.doesNotThrow(() => updateMemory(blocked, "abc123", { pending: [annotation] }));
});

test("a full store gives up the other reviews before this one's queue", () => {
  const storage = new FakeStorage();
  updateMemory(storage, "older", { draft: "someone else's review" });
  storage.budget = 0;

  updateMemory(storage, "abc123", { pending: [annotation] });

  assert.equal(storage.getItem("lsr:memory:older"), null, "room was made");
});

test("a store that is full whatever is dropped keeps the page alive", () => {
  const storage = new FakeStorage();
  storage.budget = 0;

  assert.doesNotThrow(() => updateMemory(storage, "abc123", { pending: [annotation] }));
  assert.deepEqual(readMemory(storage, "abc123").pending, []);
});

test("two untouched reviews are not handed the same arrays to fold", () => {
  const storage = new FakeStorage();

  const one = readMemory(storage, "abc123");
  const other = readMemory(storage, "def456");
  one.groups.push(4);
  one.files.push("src/api.ts");

  assert.deepEqual(other.groups, [], "one page's folds are not another's");
  assert.deepEqual(other.files, []);
  assert.deepEqual(readMemory(storage, "abc123").groups, []);
});

test("room made by dropping the other reviews is room this review's queue lands in", () => {
  const storage = new FakeStorage();
  updateMemory(storage, "older", { draft: "a".repeat(400) });
  updateMemory(storage, "oldest", { draft: "b".repeat(400) });
  // Enough for one review's record and nowhere near enough for three.
  storage.budget = 600;

  updateMemory(storage, "abc123", { pending: [annotation], draft: "and this" });

  assert.deepEqual(readMemory(storage, "abc123").pending, [annotation], "the queue is kept");
  assert.equal(readMemory(storage, "abc123").draft, "and this");
  assert.equal(storage.getItem("lsr:memory:older"), null, "the reviews it gave up are gone");
  assert.equal(storage.getItem("lsr:memory:oldest"), null);
});

test("a store too small even for that keeps the queue and lets the place go", () => {
  const storage = new FakeStorage();
  const place = { groups: [0, 1, 2], files: ["src/api.ts", "src/server.ts"], scroll: 2400 };
  // Room for the words the reviewer typed and not for where they were reading:
  // one of those can be worked out again by scrolling and the other cannot.
  const stripped = {
    v: 1,
    at: Date.now(),
    pending: [annotation],
    draft: "keep this",
    unwrapped: false,
  };
  storage.budget =
    "lsr:memory:abc123".length +
    JSON.stringify({ ...stripped, groups: [], files: [], scroll: 0 }).length +
    8;

  updateMemory(storage, "abc123", {
    pending: [annotation],
    draft: "keep this",
    round: 3,
    ...place,
  });

  const kept = readMemory(storage, "abc123");
  assert.deepEqual(kept.pending, [annotation]);
  assert.equal(kept.draft, "keep this");
  assert.deepEqual([kept.groups, kept.files, kept.scroll], [[], [], 0], "the place was let go");
  assert.equal(kept.round, undefined, "and it says so, so no round claims it");
});

test("the round a replay auto-showed for is remembered, so a reload cannot re-trigger it", () => {
  const storage = new FakeStorage();

  updateMemory(storage, "abc123", { replayed: 2 });

  assert.equal(readMemory(storage, "abc123").replayed, 2);
  assert.ok(record(storage, "abc123"), "a replay alone is worth keeping a record for");
});

test("a new round's place wipes the old place but not which replay was shown", () => {
  // `replayed` is not part of the reviewer's place: the re-group that empties
  // the place is the very moment the trigger reads `replayed` to decide.
  const storage = new FakeStorage();
  updateMemory(storage, "abc123", { round: 1, groups: [0], scroll: 900, replayed: 1 });

  updateMemory(storage, "abc123", { round: 2, groups: [2] });

  const memory = readMemory(storage, "abc123");
  assert.equal(memory.replayed, 1, "the shown replay survives the re-group");
  assert.deepEqual([memory.groups, memory.scroll], [[2], 0], "the place did not");
});

test("a review whose opening was unwrapped says so, and is worth a record on its own", () => {
  const storage = new FakeStorage();

  updateMemory(storage, "abc123", { unwrapped: true });

  assert.equal(readMemory(storage, "abc123").unwrapped, true);
  // The whole point of the flag is that it outlives the page that wrote it: a
  // record dropped for holding nothing else would open the wrapper every time.
  assert.ok(record(storage, "abc123"), "an unwrapping alone is worth keeping a record for");
});

test("a new round leaves the unwrapping standing, the way it leaves the replay", () => {
  const storage = new FakeStorage();
  updateMemory(storage, "abc123", { round: 0, scroll: 900, unwrapped: true });

  updateMemory(storage, "abc123", { round: 1, groups: [2] });

  const memory = readMemory(storage, "abc123");
  assert.equal(memory.unwrapped, true, "the wrapper is opened once per review, not per round");
  assert.equal(memory.scroll, 0, "the place did not survive it");
});

test("a corrupt unwrapped flag reads as a review nobody has opened yet", () => {
  const storage = new FakeStorage();
  storage.setItem("lsr:memory:abc123", JSON.stringify({ v: 1, at: 1, unwrapped: "yes" }));

  assert.equal(readMemory(storage, "abc123").unwrapped, false);
});

test("a corrupt replayed round comes back as never shown, not as a crash or a lie", () => {
  const storage = new FakeStorage();
  storage.setItem(
    "lsr:memory:abc123",
    JSON.stringify({ v: 1, at: 1, draft: "kept", replayed: "two" }),
  );

  const memory = readMemory(storage, "abc123");
  assert.equal(memory.replayed, undefined);
  assert.equal(memory.draft, "kept");
});

test("a negative replayed round is corruption, read as never shown", () => {
  const storage = new FakeStorage();
  storage.setItem("lsr:memory:abc123", JSON.stringify({ v: 1, at: 1, replayed: -2, round: -1 }));

  const memory = readMemory(storage, "abc123");
  assert.equal(memory.replayed, undefined);
  assert.equal(memory.round, undefined, "no stored integer here may be negative");
});

test("the focused chapter comes back in the round it was focused in", () => {
  const storage = new FakeStorage();

  updateMemory(storage, "abc123", { round: 2, focus: 1, scroll: 120 });

  assert.deepEqual(reviewPlace(readMemory(storage, "abc123"), 2), {
    groups: [],
    files: [],
    scroll: 120,
    focus: 1,
  });
});

test("a new round drops the focus with the rest of the place", () => {
  // A re-group renumbers the chapters, so chapter 1 of the old grouping says
  // nothing about the new one.
  const storage = new FakeStorage();
  updateMemory(storage, "abc123", { round: 2, focus: 1 });

  updateMemory(storage, "abc123", { round: 3, scroll: 10 });

  assert.equal(readMemory(storage, "abc123").focus, undefined);
});

test("a corrupt focus is dropped alone", () => {
  const storage = new FakeStorage({
    "lsr:memory:abc123": JSON.stringify({ v: 1, focus: "two", draft: "kept" }),
  });

  assert.equal(readMemory(storage, "abc123").focus, undefined);
  assert.equal(readMemory(storage, "abc123").draft, "kept");
});
