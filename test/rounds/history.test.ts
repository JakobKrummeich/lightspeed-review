import { test } from "node:test";
import assert from "node:assert/strict";
import {
  carriedApproval,
  changedBetween,
  fileApproval,
  fileHistory,
  firstSeenRound,
  roundApproval,
  settled,
} from "../../src/rounds/history.ts";
import type { RoundFile, SessionRound } from "../../src/session-store.ts";

/** A round as `start` writes it, closed with whatever was ticked approved. */
function round(index: number, files: RoundFile[], approvedAtEnd: string[] = []): SessionRound {
  return {
    index,
    at: `2026-02-1${index}T00:00:00.000Z`,
    baseCommit: `base${index}`,
    headCommit: `head${index}`,
    files,
    approvedAtEnd,
  };
}

function file(path: string, blob: string | null, previousPath?: string): RoundFile {
  return {
    path,
    status: previousPath === undefined ? "modified" : "renamed",
    blob,
    ...(previousPath === undefined ? {} : { previousPath }),
  };
}

test("fileHistory lists a file's rounds oldest first", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa2222")]),
  ];

  assert.deepEqual(fileHistory(rounds, "src/a.ts"), [
    { round: 0, path: "src/a.ts", blob: "aaa1111", status: "modified", approved: true },
    { round: 1, path: "src/a.ts", blob: "aaa2222", status: "modified", approved: false },
  ]);
});

test("fileHistory skips rounds the file was not part of", () => {
  const rounds = [round(0, [file("src/b.ts", "bbb1111")]), round(1, [file("src/a.ts", "aaa1111")])];

  assert.deepEqual(fileHistory(rounds, "src/a.ts"), [
    { round: 1, path: "src/a.ts", blob: "aaa1111", status: "modified", approved: false },
  ]);
});

test("fileHistory follows a rename back to the name the file had then", () => {
  const rounds = [
    round(0, [file("src/old.ts", "01d1111")], ["src/old.ts"]),
    round(1, [file("src/new.ts", "5ee1111", "src/old.ts")]),
  ];

  assert.deepEqual(fileHistory(rounds, "src/new.ts"), [
    { round: 0, path: "src/old.ts", blob: "01d1111", status: "modified", approved: true },
    { round: 1, path: "src/new.ts", blob: "5ee1111", status: "renamed", approved: false },
  ]);
});

test("changedBetween compares the blobs of the two rounds", () => {
  const first = round(0, [file("src/a.ts", "aaa1111")]);
  const same = round(1, [file("src/a.ts", "aaa1111")]);
  const edited = round(1, [file("src/a.ts", "aaa2222")]);

  assert.equal(changedBetween(first, same, "src/a.ts"), false);
  assert.equal(changedBetween(first, edited, "src/a.ts"), true);
});

test("changedBetween resolves the earlier round's name across a rename", () => {
  const first = round(0, [file("src/old.ts", "aaa1111")]);
  const renamedOnly = round(1, [file("src/new.ts", "aaa1111", "src/old.ts")]);

  assert.equal(changedBetween(first, renamedOnly, "src/new.ts"), false);
});

test("changedBetween sees through an abbreviation git widened between rounds", () => {
  const narrow = round(0, [file("src/a.ts", "4c9f88d")]);
  const wide = round(1, [file("src/a.ts", "4c9f88de")]);
  const other = round(1, [file("src/a.ts", "4c9f88e0")]);

  assert.equal(changedBetween(narrow, wide, "src/a.ts"), false);
  assert.equal(changedBetween(narrow, other, "src/a.ts"), true);
});

test("changedBetween trusts no sha shorter than git's own floor of seven", () => {
  const narrow = round(0, [file("src/a.ts", "587b")]);
  const same = round(1, [file("src/a.ts", "587b")]);

  // `core.abbrev=4` is the user's to set, and four hex digits collide once in
  // 65536 edits — too often to let a file keep an approval on.
  assert.equal(changedBetween(narrow, same, "src/a.ts"), true);
});

test("changedBetween holds a deletion still, however wide the zeroes are written", () => {
  const narrow = round(0, [file("src/gone.ts", "0000000")]);
  const wide = round(1, [file("src/gone.ts", "0000000000000000")]);

  assert.equal(changedBetween(narrow, wide, "src/gone.ts"), false);
});

test("changedBetween reports a change when either round cannot prove sameness", () => {
  const missing = round(0, []);
  const present = round(1, [file("src/a.ts", "aaa1111")]);
  const binary = round(1, [file("src/a.ts", null)]);

  assert.equal(changedBetween(missing, present, "src/a.ts"), true);
  assert.equal(changedBetween(present, binary, "src/a.ts"), true);
});

test("settled reports an approved file nobody touched afterwards", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa1111")]),
  ];

  assert.deepEqual(settled(rounds, "src/a.ts"), { approvedAtBlob: "aaa1111", changedSince: false });
});

test("settled reports an approved file that changed afterwards", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa2222")]),
  ];

  assert.deepEqual(settled(rounds, "src/a.ts"), { approvedAtBlob: "aaa1111", changedSince: true });
});

test("settled reports nothing approved once the reviewer took the tick back", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    // Closed unticked, with the file exactly where it was approved: a decision,
    // not an edit.
    round(1, [file("src/a.ts", "aaa1111")], []),
    round(2, [file("src/a.ts", "aaa1111")]),
  ];

  assert.deepEqual(settled(rounds, "src/a.ts"), { approvedAtBlob: null, changedSince: false });
  assert.equal(fileApproval(rounds, "src/a.ts"), "unapproved");
});

test("the round being reviewed has not withdrawn an approval, it has not closed", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    // The open round always holds an empty `approvedAtEnd`; reading that as a
    // withdrawal would undo every approval the moment a round opened.
    round(1, [file("src/a.ts", "aaa1111")], []),
  ];

  assert.equal(fileApproval(rounds, "src/a.ts"), "approved");
});

test("an edit is not a withdrawal, so it still reads as changed after approval", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa2222")], []),
    round(2, [file("src/a.ts", "aaa2222")]),
  ];

  assert.equal(fileApproval(rounds, "src/a.ts"), "needs-reapproval");
});

test("settled reports nothing approved for a file that was never ticked", () => {
  const rounds = [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])];

  assert.deepEqual(settled(rounds, "src/a.ts"), { approvedAtBlob: null, changedSince: false });
});

test("settled follows a rename, so approval survives the new name", () => {
  const rounds = [
    round(0, [file("src/old.ts", "aaa1111")], ["src/old.ts"]),
    round(1, [file("src/new.ts", "aaa1111", "src/old.ts")]),
  ];

  assert.deepEqual(settled(rounds, "src/new.ts"), {
    approvedAtBlob: "aaa1111",
    changedSince: false,
  });
});

test("settled answers from a single round", () => {
  const rounds = [round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"])];

  assert.deepEqual(settled(rounds, "src/a.ts"), { approvedAtBlob: "aaa1111", changedSince: false });
  assert.deepEqual(settled(rounds, "src/other.ts"), { approvedAtBlob: null, changedSince: false });
  assert.deepEqual(settled([], "src/a.ts"), { approvedAtBlob: null, changedSince: false });
});

test("settled takes the latest approval when a file is approved twice", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa2222")], ["src/a.ts"]),
    round(2, [file("src/a.ts", "aaa3333")]),
  ];

  assert.deepEqual(settled(rounds, "src/a.ts"), { approvedAtBlob: "aaa2222", changedSince: true });
});

test("a file on its first round, and one the rounds never mention, are unapproved", () => {
  const rounds = [round(0, [file("src/a.ts", "aaa1111")])];

  assert.equal(fileApproval(rounds, "src/a.ts"), "unapproved");
  assert.equal(fileApproval(rounds, "src/never-seen.ts"), "unapproved");
});

test("firstSeenRound is the round the file entered the review, across renames", () => {
  const rounds = [
    round(0, [file("src/old.ts", "aaa1111")]),
    round(1, [file("src/new.ts", "aaa2222", "src/old.ts"), file("src/b.ts", "bbb1111")]),
  ];

  assert.equal(firstSeenRound(rounds, "src/new.ts"), 0);
  assert.equal(firstSeenRound(rounds, "src/b.ts"), 1);
  assert.equal(firstSeenRound(rounds, "src/never-seen.ts"), null);
});

test("a file approved earlier and untouched since is approved", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa1111")]),
  ];

  assert.equal(fileApproval(rounds, "src/a.ts"), "approved");
});

test("a file the agent edited after approval needs approving again", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa2222")]),
  ];

  assert.equal(fileApproval(rounds, "src/a.ts"), "needs-reapproval");
});

test("a file nobody ever approved is unapproved, not awaiting re-approval", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")]),
    round(1, [file("src/a.ts", "aaa1111")]),
    round(2, [file("src/a.ts", "aaa1111")]),
  ];

  assert.equal(fileApproval(rounds, "src/a.ts"), "unapproved");
});

test("approval survives a rename, since the blob did not move", () => {
  const rounds = [
    round(0, [file("src/old.ts", "aaa1111")], ["src/old.ts"]),
    round(1, [file("src/new.ts", "aaa1111", "src/old.ts")]),
  ];

  assert.equal(fileApproval(rounds, "src/new.ts"), "approved");
});

test("a file without a blob sha is never approved, however often it was ticked", () => {
  const rounds = [
    round(0, [file("bin/logo.png", null)], ["bin/logo.png"]),
    round(1, [file("bin/logo.png", null)]),
  ];

  assert.equal(fileApproval(rounds, "bin/logo.png"), "unapproved");
});

test("a rename git found identical names no blob, so it is asked for again", () => {
  const rounds = [
    round(0, [file("src/new.ts", null, "src/old.ts")], ["src/new.ts"]),
    round(1, [file("src/new.ts", null, "src/old.ts")]),
  ];

  assert.equal(fileApproval(rounds, "src/new.ts"), "unapproved");
});

test("approval survives an abbreviation that grew, and not an edit", () => {
  const approvedNarrow = round(0, [file("src/a.ts", "4c9f88d")], ["src/a.ts"]);

  assert.equal(
    fileApproval([approvedNarrow, round(1, [file("src/a.ts", "4c9f88de")])], "src/a.ts"),
    "approved",
  );
  assert.equal(
    fileApproval([approvedNarrow, round(1, [file("src/a.ts", "4c9f88e0")])], "src/a.ts"),
    "needs-reapproval",
  );
});

test("roundApproval answers for every file of the round being reviewed now", () => {
  const rounds = [
    round(
      0,
      [file("src/a.ts", "aaa1111"), file("src/b.ts", "bbb1111"), file("src/d.ts", "ddd1111")],
      ["src/a.ts", "src/d.ts"],
    ),
    round(1, [
      file("src/a.ts", "aaa1111"),
      file("src/b.ts", "bbb2222"),
      file("src/c.ts", "ccc1111"),
      file("src/d.ts", "ddd2222"),
    ]),
  ];

  // `src/a.ts` arrived ticked and is ticked still; `src/d.ts` was ticked once
  // and the agent edited it, which is why it is not in the live set.
  assert.deepEqual(roundApproval(rounds, ["src/a.ts"]), {
    "src/a.ts": "approved",
    "src/b.ts": "unapproved",
    "src/c.ts": "unapproved",
    "src/d.ts": "needs-reapproval",
  });
});

test("roundApproval follows the reviewer's ticks the moment they change", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111"), file("src/b.ts", "bbb1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa1111"), file("src/b.ts", "bbb1111")]),
  ];

  // Unticked a carried file: no round has closed since, and the answer changes
  // anyway, because the checkbox is the reviewer speaking.
  assert.deepEqual(roundApproval(rounds, []), {
    "src/a.ts": "unapproved",
    "src/b.ts": "unapproved",
  });
  // Ticked a file for the first time, in the round still open.
  assert.deepEqual(roundApproval(rounds, ["src/a.ts", "src/b.ts"]), {
    "src/a.ts": "approved",
    "src/b.ts": "approved",
  });
});

test("roundApproval of a review with no rounds is empty", () => {
  assert.deepEqual(roundApproval([], []), {});
});

test("carriedApproval reads the newest round as open, so its own ticks do not vouch", () => {
  const closed = [
    round(0, [file("src/a.ts", "aaa1111"), file("src/b.ts", "bbb1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa1111"), file("src/b.ts", "bbb1111")], ["src/b.ts"]),
  ];

  assert.deepEqual(carriedApproval(closed), ["src/a.ts"]);
  assert.deepEqual(carriedApproval([]), []);
});
