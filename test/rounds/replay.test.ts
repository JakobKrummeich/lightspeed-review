import { test } from "node:test";
import assert from "node:assert/strict";
import { replayData, type ReadBetween, type ReadFileAt } from "../../src/rounds/replay.ts";
import { MAX_APPROVED_FORM_BYTES } from "../../src/rounds/approved-form.ts";
import type {
  AnnotationPrompt,
  ConversationEntry,
  SessionRecord,
  SessionRound,
} from "../../src/session-store.ts";

/**
 * The replay is computed, never stored: tests build the session two `start`s would leave and
 * hand the module a git of their own (`readBetween` answers with a test-written patch).
 */

const FROM = "a".repeat(40);
const TO = "b".repeat(40);

function round(index: number, overrides: Partial<SessionRound> = {}): SessionRound {
  return {
    index,
    at: `2024-01-0${index + 1}T00:00:00.000Z`,
    headCommit: index === 0 ? FROM : TO,
    files: [{ path: "src/a.ts", status: "modified", blob: `blob-${index}-aaaaa` }],
    approvedAtEnd: [],
    ...overrides,
  };
}

function annotation(overrides: Partial<AnnotationPrompt> = {}): AnnotationPrompt {
  return {
    type: "annotation",
    id: "evt-1",
    file: "src/a.ts",
    group: "Core",
    selected_text: "old line",
    comment: "why is this here?",
    side: "new",
    line_start: 10,
    line_end: 12,
    ...overrides,
  };
}

function reviewerEntry(roundIndex: number, prompts: AnnotationPrompt[]): ConversationEntry {
  return { role: "reviewer", at: `2024-01-0${roundIndex + 1}T12:00:00.000Z`, roundIndex, prompts };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: "k",
    repoRoot: "/repo",
    branch: "feature",
    base: "main",
    status: "open",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-02T00:00:00.000Z",
    groups: [],
    conversation: [reviewerEntry(0, [annotation()])],
    pending: [],
    approved: [],
    rounds: [round(0), round(1)],
    ...overrides,
  };
}

/** A one-file patch with two hunks: old lines 10-12 and old lines 50-51. */
function patchFor(path: string, oldPath = path): string {
  return [
    `diff --git a/${oldPath} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${oldPath}`,
    `+++ b/${path}`,
    "@@ -10,3 +10,4 @@",
    " context",
    "-old line",
    "+new line",
    "+second new line",
    "@@ -50,2 +51,2 @@",
    " far away",
    "-tail",
    "+fixed tail",
    "",
  ].join("\n");
}

/** The same one-file patch with the two hunk headers the test chooses. */
function patchWithHunks(first: string, second: string): string {
  return [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    first,
    " context",
    "-old line",
    "+new line",
    second,
    " far away",
    "-tail",
    "+fixed tail",
    "",
  ].join("\n");
}

const answersWith =
  (patch: string): ReadBetween =>
  () => ({ state: "patch", patch });

const neverAsked: ReadBetween = () => {
  assert.fail("git was asked for a diff no card needed");
};

const noFile: ReadFileAt = () => undefined;

function replay(record: SessionRecord, readBetween: ReadBetween, readFileAt: ReadFileAt = noFile) {
  return replayData(record, readBetween, readFileAt);
}

test("a first round has no round before it, so the replay is definitively empty", () => {
  const record = session({ rounds: [round(0)], conversation: [reviewerEntry(0, [annotation()])] });

  assert.deepEqual(replay(record, neverAsked), { comments: [] });
});

test("only last round's reviewer annotations become cards, in the order they were made", () => {
  const record = session({
    rounds: [round(0), round(1, { headCommit: "c".repeat(40) }), round(2, { headCommit: TO })],
    conversation: [
      reviewerEntry(0, [annotation({ id: "evt-old", comment: "two rounds ago" })]),
      reviewerEntry(1, [
        annotation({ id: "evt-a", comment: "first" }),
        annotation({ id: "evt-b", comment: "second" }),
      ]),
      reviewerEntry(2, [annotation({ id: "evt-now", comment: "this round" })]),
    ],
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  assert.deepEqual(
    comments.map((comment) => comment.id),
    ["evt-a", "evt-b"],
  );
});

test("a general message is about the review, not a file, and gets no card", () => {
  const record = session({
    conversation: [
      { role: "reviewer", at: "t", roundIndex: 0, prompts: [{ type: "message", comment: "hi" }] },
    ],
  });

  assert.deepEqual(replay(record, answersWith(patchFor("src/a.ts"))).comments, []);
});

test("a card carries the comment as it was made: id, file, group, anchor, words", () => {
  const { comments } = replay(session(), answersWith(patchFor("src/a.ts")));

  const [card] = comments;
  assert.equal(card?.id, "evt-1");
  assert.equal(card?.file, "src/a.ts");
  assert.equal(card?.group, "Core");
  assert.deepEqual(card?.anchor, { side: "new", line_start: 10, line_end: 12 });
  assert.equal(card?.selected_text, "old line");
  assert.equal(card?.comment, "why is this here?");
});

test("an anchorless comment says so with a null anchor, not a fabricated range", () => {
  const record = session({
    conversation: [
      reviewerEntry(0, [
        annotation({ side: undefined, line_start: undefined, line_end: undefined }),
      ]),
    ],
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  assert.equal(comments[0]?.anchor, null);
});

test("a declared comment serves the declared files' hunks and the agent's note", () => {
  const record = session({
    declarations: {
      "evt-1": { note: "moved the guard", files: ["src/a.ts"], at: "t" },
    },
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  const [card] = comments;
  assert.equal(card?.declared, true);
  assert.equal(card?.note, "moved the guard");
  assert.equal(card?.state, "ok");
  assert.equal(card?.answers.length, 1);
  assert.equal(card?.answers[0]?.file, "src/a.ts");
  assert.equal(card?.answers[0]?.hunks.length, 2, "declared files come whole, never anchor-cut");
  assert.match(card?.answers[0]?.hunks[0]?.body ?? "", /\+new line/);
});

test("a declaration spanning files yields one labelled answer per file", () => {
  const asked: string[][] = [];
  const record = session({
    declarations: { "evt-1": { files: ["src/a.ts", "src/b.ts"], at: "t" } },
  });
  const readBetween: ReadBetween = (from, to, paths) => {
    assert.equal(from, FROM, "the diff starts at last round's head — the code the comment was on");
    assert.equal(to, TO, "and ends at the round on screen");
    asked.push(paths);
    const path = paths.includes("src/b.ts") ? "src/b.ts" : "src/a.ts";
    return { state: "patch", patch: patchFor(path) };
  };

  const { comments } = replay(record, readBetween);

  assert.deepEqual(
    comments[0]?.answers.map((answer) => answer.file),
    ["src/a.ts", "src/b.ts"],
  );
  assert.ok(comments[0]?.answers.every((answer) => answer.hunks.length === 2));
});

test("a note-only declaration is a valid answer: declared, no hunks, no failure state", () => {
  const record = session({
    declarations: { "evt-1": { note: "that is intentional, see the ADR", files: [], at: "t" } },
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  const [card] = comments;
  assert.equal(card?.declared, true);
  assert.deepEqual(card?.answers, []);
  assert.equal(card?.note, "that is intentional, see the ADR");
  assert.equal(card?.state, "ok");
});

test("an undeclared comment falls back to the hunks its anchor overlaps", () => {
  const { comments } = replay(session(), answersWith(patchFor("src/a.ts")));

  const [card] = comments;
  assert.equal(card?.declared, false);
  assert.equal(card?.note, undefined, "no declaration means no note, never an invented one");
  assert.equal(card?.answers.length, 1);
  assert.equal(card?.answers[0]?.hunks.length, 1, "only the hunk the anchor overlaps");
  assert.match(card?.answers[0]?.hunks[0]?.header ?? "", /^@@ -10,3/);
});

test("an anchor reaching one hunk's last old line only is cut to exactly that hunk", () => {
  // Ranges 10-12/50-51, anchor 13..50: only the second overlaps. One line too wide sweeps the
  // first in, and the nearest-hunk fallback would mask it.
  const record = session({
    conversation: [reviewerEntry(0, [annotation({ line_start: 13, line_end: 50 })])],
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  assert.equal(comments[0]?.answers[0]?.hunks.length, 1);
  assert.match(comments[0]?.answers[0]?.hunks[0]?.header ?? "", /^@@ -50,2/);
});

test("a hunk's last old line is inside it: an anchor ending there takes it whole", () => {
  // Ranges 10-12/14-15, anchor 12..14: both overlap. One line too short drops the first hunk.
  const record = session({
    conversation: [reviewerEntry(0, [annotation({ line_start: 12, line_end: 14 })])],
  });

  const patch = patchWithHunks("@@ -10,3 +10,3 @@", "@@ -14,2 +14,2 @@");
  const { comments } = replay(record, answersWith(patch));

  assert.deepEqual(
    comments[0]?.answers[0]?.hunks.map((hunk) => hunk.header),
    ["@@ -10,3 +10,3 @@\n", "@@ -14,2 +14,2 @@\n"],
  );
});

test("one line past a hunk's last old line is outside it", () => {
  // Same ranges, anchor 13..14: only the second may answer. One line too wide claims the first at 13.
  const record = session({
    conversation: [reviewerEntry(0, [annotation({ line_start: 13, line_end: 14 })])],
  });

  const patch = patchWithHunks("@@ -10,3 +10,3 @@", "@@ -14,2 +14,2 @@");
  const { comments } = replay(record, answersWith(patch));

  assert.deepEqual(
    comments[0]?.answers[0]?.hunks.map((hunk) => hunk.header),
    ["@@ -14,2 +14,2 @@\n"],
  );
});

test("an anchor spanning several hunks serves every one of them, not the first", () => {
  const record = session({
    conversation: [reviewerEntry(0, [annotation({ line_start: 10, line_end: 51 })])],
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  assert.equal(comments[0]?.answers[0]?.hunks.length, 2);
});

test("an anchor overlapping nothing falls back to the nearest hunk", () => {
  const record = session({
    conversation: [reviewerEntry(0, [annotation({ line_start: 40, line_end: 44 })])],
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  assert.equal(comments[0]?.answers[0]?.hunks.length, 1);
  assert.match(comments[0]?.answers[0]?.hunks[0]?.header ?? "", /^@@ -50,2/);
});

test("an old-side anchor cannot be mapped onto the between-round diff, so the whole file answers", () => {
  // The between-round diff's old side is last round's head; an old-side anchor
  // points into last round's base, which that diff never shows.
  const record = session({
    conversation: [reviewerEntry(0, [annotation({ side: "old" })])],
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  assert.equal(comments[0]?.answers[0]?.hunks.length, 2);
});

test("an anchorless comment gets the whole file too", () => {
  const record = session({
    conversation: [
      reviewerEntry(0, [
        annotation({ side: undefined, line_start: undefined, line_end: undefined }),
      ]),
    ],
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  assert.equal(comments[0]?.answers[0]?.hunks.length, 2);
});

test("a comment from before ids existed is served with a null id and mechanical answers", () => {
  const record = session({
    conversation: [reviewerEntry(0, [annotation({ id: undefined })])],
    declarations: { "evt-1": { note: "not yours", files: ["src/a.ts"], at: "t" } },
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  const [card] = comments;
  assert.equal(card?.id, null);
  assert.equal(card?.declared, false, "no id can never match a declaration");
  assert.equal(card?.note, undefined);
  assert.equal(card?.answers[0]?.hunks.length, 1);
});

test("a rename is followed: the answer is cut under the file's name today", () => {
  const record = session({
    rounds: [
      round(0),
      round(1, {
        files: [
          { path: "src/renamed.ts", previousPath: "src/a.ts", status: "renamed", blob: "b1zzzzz" },
        ],
      }),
    ],
  });
  const asked: string[][] = [];
  const readBetween: ReadBetween = (_from, _to, paths) => {
    asked.push(paths);
    return { state: "patch", patch: patchFor("src/renamed.ts", "src/a.ts") };
  };

  const { comments } = replay(record, readBetween);

  assert.ok(
    asked.every((paths) => paths.includes("src/a.ts") && paths.includes("src/renamed.ts")),
    `git must be given both ends of the rename, got ${JSON.stringify(asked)}`,
  );
  assert.equal(comments[0]?.answers[0]?.file, "src/renamed.ts");
  assert.equal(comments[0]?.answers[0]?.hunks.length, 1);
});

test("a touched file that was not raised again reads as addressed", () => {
  // round(0) and round(1) record different blobs for src/a.ts.
  const { comments } = replay(session(), answersWith(patchFor("src/a.ts")));

  assert.equal(comments[0]?.status, "addressed");
});

test("an untouched, unapproved file reads as unchanged — never as ignored", () => {
  const blob = "same-blob-1234567";
  const record = session({
    rounds: [
      round(0, { files: [{ path: "src/a.ts", status: "modified", blob }] }),
      round(1, { files: [{ path: "src/a.ts", status: "modified", blob }] }),
    ],
  });

  const { comments } = replay(record, answersWith(""));

  assert.equal(comments[0]?.status, "unchanged");
  assert.deepEqual(comments[0]?.answers, [], "an empty patch has no hunks to offer");
});

test("a file the reviewer marked again in a later round reads as repeated", () => {
  const record = session({
    conversation: [
      reviewerEntry(0, [annotation()]),
      reviewerEntry(1, [annotation({ id: "evt-2", comment: "still wrong" })]),
    ],
  });

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")));

  assert.equal(comments[0]?.status, "repeated");
});

test("an untouched file whose approval still stands reads as addressed", () => {
  const blob = "same-blob-1234567";
  const record = session({
    rounds: [
      round(0, {
        files: [{ path: "src/a.ts", status: "modified", blob }],
        approvedAtEnd: ["src/a.ts"],
      }),
      round(1, { files: [{ path: "src/a.ts", status: "modified", blob }] }),
    ],
  });

  const { comments } = replay(record, answersWith(""));

  assert.equal(comments[0]?.status, "addressed");
});

test("a current round without a commit is unrecorded too, and blames no rebase either", () => {
  const record = session({
    rounds: [round(0), round(1, { headCommit: undefined })],
  });

  const { comments } = replay(record, neverAsked);

  assert.equal(comments[0]?.state, "unrecorded");
  assert.equal(comments[0]?.status, "unknown");
});

test("rounds that never recorded commits degrade to a status-only card, blaming no rebase", () => {
  const record = session({
    rounds: [round(0, { headCommit: undefined }), round(1)],
    declarations: { "evt-1": { note: "fixed", files: [], at: "t" } },
  });

  const { comments } = replay(record, neverAsked);

  const [card] = comments;
  assert.equal(card?.state, "unrecorded");
  assert.equal(card?.status, "unknown");
  assert.deepEqual(card?.answers, []);
  assert.equal(card?.note, "fixed", "the agent's word survives missing git history");
});

test("a commit a rebase took away degrades to a status-only card marked unreachable", () => {
  const record = session({
    declarations: { "evt-1": { files: ["src/a.ts"], at: "t" } },
  });

  const { comments } = replay(record, () => ({ state: "unreachable" }));

  const [card] = comments;
  assert.equal(card?.state, "unreachable");
  assert.equal(card?.status, "unknown");
  assert.deepEqual(card?.answers, []);
  assert.equal(card?.declared, true);
});

test("a between-round diff too big for git's buffer degrades to a status-only card", () => {
  const { comments } = replay(session(), () => ({ state: "oversize" }));

  assert.equal(comments[0]?.state, "oversize");
  assert.equal(comments[0]?.status, "unknown");
  assert.deepEqual(comments[0]?.answers, []);
});

test("a declared card outlives the annotated file's own diff being unreadable", () => {
  // The annotated file's patch is unreadable but the declared answer lives in a modest file:
  // the declaration is what the card is made of; only the status degrades to unknown.
  const record = session({
    declarations: { "evt-1": { note: "split it out", files: ["src/b.ts"], at: "t" } },
  });
  const readBetween: ReadBetween = (_from, _to, paths) =>
    paths.includes("src/b.ts")
      ? { state: "patch", patch: patchFor("src/b.ts") }
      : { state: "oversize" };

  const { comments } = replay(record, readBetween);

  const [card] = comments;
  assert.equal(card?.state, "ok");
  assert.equal(card?.status, "unknown");
  assert.equal(card?.declared, true);
  assert.equal(card?.answers[0]?.file, "src/b.ts");
  assert.equal(card?.answers[0]?.hunks.length, 2);
});

test("one file's patch past the render cap withholds its hunks and says so", () => {
  const hugeBody = `+${"x".repeat(MAX_APPROVED_FORM_BYTES)}`;
  const huge = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,0 +1,1 @@",
    hugeBody,
    "",
  ].join("\n");

  const { comments } = replay(session(), answersWith(huge));

  const [card] = comments;
  assert.equal(card?.state, "ok");
  assert.deepEqual(card?.answers, [{ file: "src/a.ts", hunks: [], oversized: true }]);
});

test("a binary file has no lines to show, and its answer says so with empty hunks", () => {
  const binary = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "Binary files a/src/a.ts and b/src/a.ts differ",
    "",
  ].join("\n");

  const { comments } = replay(session(), answersWith(binary));

  assert.deepEqual(comments[0]?.answers, [], "a patch with no text lines offers no hunks");
});

test("context is cut from the annotated round's own commit, around the anchor", () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  const readFileAt = (commit: string, path: string) => {
    assert.equal(commit, FROM, "a new-side anchor lives in last round's head, not today's");
    assert.equal(path, "src/a.ts");
    return lines;
  };

  const { comments } = replay(session(), answersWith(patchFor("src/a.ts")), readFileAt);

  assert.ok(comments[0]?.context?.includes("line 10"));
  assert.ok(!comments[0]?.context?.includes("line 60"), "context is a slice, not the file");
});

test("a file git cannot read leaves the card without context rather than guessing", () => {
  const { comments } = replay(session(), answersWith(patchFor("src/a.ts")), () => undefined);

  assert.equal(comments[0]?.context, undefined);
});

test("an old-side anchor's context comes from last round's base, under the old name", () => {
  const BASE = "d".repeat(40);
  const record = session({
    rounds: [
      round(0, {
        baseCommit: BASE,
        files: [
          { path: "src/a.ts", previousPath: "src/was.ts", status: "renamed", blob: "b0zzzzz" },
        ],
      }),
      round(1),
    ],
    conversation: [reviewerEntry(0, [annotation({ side: "old" })])],
  });
  const lines = Array.from({ length: 20 }, (_, i) => `old line ${i + 1}`).join("\n");
  const readFileAt: ReadFileAt = (commit, path) => {
    assert.equal(commit, BASE, "an old-side anchor lives in last round's base commit");
    assert.equal(path, "src/was.ts", "under the name the old side of that diff used");
    return lines;
  };

  const { comments } = replay(record, answersWith(patchFor("src/a.ts")), readFileAt);

  assert.ok(comments[0]?.context?.includes("old line 10"));
});
