import { test } from "node:test";
import assert from "node:assert/strict";
import { lastRoundForm } from "../../src/rounds/last-round-form.ts";
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

test("a file that moved between the last two rounds names their two heads", () => {
  const rounds = [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])];

  const form = lastRoundForm(rounds, "src/a.ts");

  assert.ok(form);
  assert.equal(form.fromCommit, "head0", "the head of the round the reviewer last read");
  assert.equal(form.toCommit, "head1", "the head of the round in front of them");
  assert.deepEqual(form.paths, ["src/a.ts"]);
});

test("only the last two rounds are compared, never any pair further back", () => {
  // Moved in round 1, still since: the reviewer already saw that edit, and nothing landed since
  // they last looked.
  const rounds = [
    round(0, [file("a.ts", "aaa1111")]),
    round(1, [file("a.ts", "aaa2222")]),
    round(2, [file("a.ts", "aaa2222")]),
  ];

  assert.equal(lastRoundForm(rounds, "a.ts"), undefined);
});

test("a review on its first round has no last round to compare against", () => {
  assert.equal(lastRoundForm([round(0, [file("a.ts", "aaa1111")])], "a.ts"), undefined);
});

test("a file the current round does not list has no form", () => {
  const rounds = [round(0, [file("a.ts", "aaa1111")]), round(1, [file("b.ts", "bbb2222")])];

  assert.equal(lastRoundForm(rounds, "a.ts"), undefined);
});

test("a file new to this round has no last round's form of itself", () => {
  const rounds = [round(0, [file("a.ts", "aaa1111")]), round(1, [file("b.ts", "bbb2222")])];

  assert.equal(lastRoundForm(rounds, "b.ts"), undefined);
});

test("a file without a sha on either side proves nothing and offers nothing", () => {
  // A binary patch names no blob: without shas to prove a change, the switch would open on a
  // diff saying "identical" — a press that answers nothing.
  const before = [round(0, [file("a.bin", null)]), round(1, [file("a.bin", "aaa2222")])];
  const after = [round(0, [file("a.bin", "aaa1111")]), round(1, [file("a.bin", null)])];

  assert.equal(lastRoundForm(before, "a.bin"), undefined);
  assert.equal(lastRoundForm(after, "a.bin"), undefined);
});

test("the same blob at two abbreviation widths is the same file", () => {
  // Older versions abbreviated shas and git widens as a repo grows: a longer record of the same
  // object must not read as an edit.
  const rounds = [round(0, [file("a.ts", "aaa1111")]), round(1, [file("a.ts", "aaa1111222")])];

  assert.equal(lastRoundForm(rounds, "a.ts"), undefined);
});

test("a needs-reapproval file keeps the approval switch and never gets this one", () => {
  // Changed between rounds too, but the approved form covers everything since the tick:
  // one comparison per file, never two.
  const rounds = [
    round(0, [file("a.ts", "aaa1111")], ["a.ts"]),
    round(1, [file("a.ts", "aaa2222")]),
  ];

  assert.equal(lastRoundForm(rounds, "a.ts"), undefined);
});

test("a file whose approval was withdrawn still gets the last-round switch", () => {
  // Unticked while its text stood still, then edited: the approved form went with the tick,
  // but the edit since last round is still unread.
  const rounds = [
    round(0, [file("a.ts", "aaa1111")], ["a.ts"]),
    round(1, [file("a.ts", "aaa1111")], []),
    round(2, [file("a.ts", "aaa2222")]),
  ];

  const form = lastRoundForm(rounds, "a.ts");

  assert.ok(form);
  assert.equal(form.fromCommit, "head1");
  assert.equal(form.toCommit, "head2");
});

test("a rename between the two rounds is asked for under both names", () => {
  const rounds = [
    round(0, [file("src/old.ts", "01d1111")]),
    round(1, [file("src/new.ts", "5ee2222", "src/old.ts")]),
  ];

  const form = lastRoundForm(rounds, "src/new.ts");

  assert.ok(form);
  assert.deepEqual(form.paths, ["src/old.ts", "src/new.ts"], "git is given both ends");
});

test("a rename that predates both rounds is matched by today's name", () => {
  // Every round diffs against the same base, so an old rename stamps `previousPath` on both
  // records — but the last round already listed the new name, and that is the name to pair on.
  const rounds = [
    round(0, [file("src/new.ts", "aaa1111", "src/old.ts")]),
    round(1, [file("src/new.ts", "aaa2222", "src/old.ts")]),
  ];

  const form = lastRoundForm(rounds, "src/new.ts");

  assert.ok(form);
  assert.deepEqual(form.paths, ["src/new.ts"], "one name, asked for once");
});

test("a round that recorded no head commit cannot be diffed against", () => {
  const rounds: SessionRound[] = [
    {
      index: 0,
      at: "2026-03-10T00:00:00.000Z",
      files: [file("a.ts", "aaa1111")],
      approvedAtEnd: [],
    },
    round(1, [file("a.ts", "aaa2222")]),
  ];

  const form = lastRoundForm(rounds, "a.ts");

  assert.ok(form, "the change is proven; only the commit is missing");
  assert.equal(form.fromCommit, null);
  assert.equal(form.toCommit, "head1");
});
