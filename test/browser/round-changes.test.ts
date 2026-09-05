import { test } from "node:test";
import assert from "node:assert/strict";
import { changedSinceLastRound } from "../../src/browser/round-changes.ts";
import type { RoundFile } from "../../src/session-store.ts";

function file(path: string, blob: string | null, previousPath?: string): RoundFile {
  return {
    path,
    status: previousPath === undefined ? "modified" : "renamed",
    blob,
    ...(previousPath === undefined ? {} : { previousPath }),
  };
}

/** A round as the wire carries it, of which this question reads only `files`. */
function round(files: RoundFile[]): { files: RoundFile[] } {
  return { files };
}

test("the files whose blobs moved between the last two rounds, and no others", () => {
  const rounds = [
    round([file("a.ts", "aaa1111"), file("b.ts", "bbb1111")]),
    round([file("a.ts", "aaa2222"), file("b.ts", "bbb1111")]),
  ];

  assert.deepEqual(changedSinceLastRound(rounds), new Set(["a.ts"]));
});

test("a first round has no last round to have changed since", () => {
  assert.deepEqual(changedSinceLastRound([round([file("a.ts", "aaa1111")])]), new Set());
  assert.deepEqual(changedSinceLastRound([]), new Set());
});

test("a round the wire stripped the files from answers nothing rather than guessing", () => {
  // The panel's `RoundMark`s carry no files; a payload that narrow simply has
  // no blobs to compare, and an empty set is the honest reading of it.
  const rounds = [{}, round([file("a.ts", "aaa2222")])];

  assert.deepEqual(changedSinceLastRound(rounds), new Set());
});

test("only the last two rounds are read, never any pair further back", () => {
  const rounds = [
    round([file("a.ts", "aaa1111")]),
    round([file("a.ts", "aaa2222")]),
    round([file("a.ts", "aaa2222")]),
  ];

  assert.deepEqual(changedSinceLastRound(rounds), new Set());
});

test("a file new to this round has no last round's form to have moved from", () => {
  const rounds = [round([file("a.ts", "aaa1111")]), round([file("b.ts", "bbb2222")])];

  assert.deepEqual(changedSinceLastRound(rounds), new Set());
});

test("a file without a sha on either side proves nothing", () => {
  const rounds = [
    round([file("a.bin", null), file("b.bin", "bbb1111")]),
    round([file("a.bin", "aaa2222"), file("b.bin", null)]),
  ];

  assert.deepEqual(changedSinceLastRound(rounds), new Set());
});

test("the same blob at two abbreviation widths is the same file", () => {
  const rounds = [round([file("a.ts", "aaa1111")]), round([file("a.ts", "aaa1111222")])];

  assert.deepEqual(changedSinceLastRound(rounds), new Set());
});

test("a rename between the rounds is followed to its old name", () => {
  const rounds = [
    round([file("src/old.ts", "01d1111")]),
    round([file("src/new.ts", "5ee2222", "src/old.ts")]),
  ];

  assert.deepEqual(changedSinceLastRound(rounds), new Set(["src/new.ts"]));
});
