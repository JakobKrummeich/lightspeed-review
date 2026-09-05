import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedForm } from "../../src/rounds/approved-form.ts";
import type { RoundFile, SessionRound } from "../../src/session-store.ts";

/** A round as `start` writes it. */
function round(index: number, files: RoundFile[], approvedAtEnd: string[] = []): SessionRound {
  return {
    index,
    at: `2026-03-1${index}T00:00:00.000Z`,
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

test("a file the agent edited after approval names the two commits to diff", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa2222")]),
  ];

  const form = approvedForm(rounds, "src/a.ts");

  assert.ok(form);
  assert.equal(form.fromCommit, "head0", "the head of the round they signed off");
  assert.equal(form.toCommit, "head1", "the head of the round in front of them");
  assert.deepEqual(form.paths, ["src/a.ts"]);
});

test("the approval is read against the round it was given in, not the first one", () => {
  // Rounds 0 and 1 hold the same bytes: round 1's tick stands, round 2 undid it.
  // Taking round 0's head would diff a tree the reviewer never approved.
  const rounds = [
    round(0, [file("a.ts", "aaa1111")]),
    round(1, [file("a.ts", "aaa1111")], ["a.ts"]),
    round(2, [file("a.ts", "aaa2222")]),
  ];

  const form = approvedForm(rounds, "a.ts");

  assert.ok(form);
  assert.equal(form.fromCommit, "head1", "the head of the round the tick was given in");
  assert.equal(form.toCommit, "head2");
});

test("a file that never moved since approval has no approved form to show", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa1111")]),
  ];

  assert.equal(approvedForm(rounds, "src/a.ts"), undefined);
});

test("a file nobody ever approved has no approved form to show", () => {
  const rounds = [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])];

  assert.equal(approvedForm(rounds, "src/a.ts"), undefined);
});

test("a file the reviewer took their approval back from has none either", () => {
  // Unticked while its text stood still: a decision, not an edit — so there is
  // nothing they approved for the other side of the toggle to show.
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/a.ts", "aaa1111")], []),
    round(2, [file("src/a.ts", "aaa2222")]),
  ];

  assert.equal(approvedForm(rounds, "src/a.ts"), undefined);
});

test("a rename since the approval is asked for under both names", () => {
  const rounds = [
    round(0, [file("src/old.ts", "01d1111")], ["src/old.ts"]),
    round(1, [file("src/new.ts", "5ee2222", "src/old.ts")]),
  ];

  const form = approvedForm(rounds, "src/new.ts");

  assert.ok(form);
  assert.deepEqual(form.paths, ["src/old.ts", "src/new.ts"], "git is given every name it had");
  assert.equal(form.fromCommit, "head0");
});

test("two renames since the approval name every step, oldest first", () => {
  const rounds = [
    round(0, [file("src/one.ts", "0ne1111")], ["src/one.ts"]),
    round(1, [file("src/two.ts", "2wo2222", "src/one.ts")]),
    round(2, [file("src/three.ts", "3hr3333", "src/two.ts")]),
  ];

  const form = approvedForm(rounds, "src/three.ts");

  assert.ok(form);
  assert.deepEqual(form.paths, ["src/one.ts", "src/two.ts", "src/three.ts"]);
});

test("a name the file went back to is asked for once", () => {
  const rounds = [
    round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
    round(1, [file("src/b.ts", "bbb2222", "src/a.ts")]),
    round(2, [file("src/a.ts", "aaa3333", "src/b.ts")]),
  ];

  const form = approvedForm(rounds, "src/a.ts");

  assert.ok(form);
  assert.deepEqual(form.paths, ["src/a.ts", "src/b.ts"]);
});

test("a round that recorded no head commit cannot be diffed against", () => {
  const rounds: SessionRound[] = [
    {
      index: 0,
      at: "2026-03-10T00:00:00.000Z",
      files: [file("a.ts", "aaa1111")],
      approvedAtEnd: ["a.ts"],
    },
    round(1, [file("a.ts", "aaa2222")]),
  ];

  const form = approvedForm(rounds, "a.ts");

  assert.ok(form, "the approval still stands; only the commit is missing");
  assert.equal(form.fromCommit, null);
  assert.equal(form.toCommit, "head1");
});
