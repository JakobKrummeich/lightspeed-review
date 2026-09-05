import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_FILE_BYTES,
  readDiffBetween,
  readFileAtCommit,
  type DiffBetween,
} from "../src/git-file.ts";
import { git, newRepo } from "./helpers/git-repo.ts";

function repoWithTwoCommits(): { repoRoot: string; first: string; second: string } {
  const repoRoot = newRepo("lsr-show-");
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src", "app.tsx"), "const a = 1;\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "first");
  const first = git(repoRoot, "rev-parse", "HEAD");
  writeFileSync(join(repoRoot, "src", "app.tsx"), "const a = 2;\nconst b = 3;\n");
  writeFileSync(join(repoRoot, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "second");
  return { repoRoot, first, second: git(repoRoot, "rev-parse", "HEAD") };
}

test("readFileAtCommit reads a path as it stood at a commit", () => {
  const { repoRoot, first, second } = repoWithTwoCommits();

  assert.equal(readFileAtCommit(repoRoot, first, "src/app.tsx"), "const a = 1;\n");
  assert.equal(readFileAtCommit(repoRoot, second, "src/app.tsx"), "const a = 2;\nconst b = 3;\n");
});

test("readFileAtCommit returns undefined for a path the commit does not have", () => {
  const { repoRoot, first } = repoWithTwoCommits();

  assert.equal(readFileAtCommit(repoRoot, first, "logo.png"), undefined);
  assert.equal(readFileAtCommit(repoRoot, first, "src/missing.ts"), undefined);
});

test("readFileAtCommit returns undefined for binary content", () => {
  const { repoRoot, second } = repoWithTwoCommits();

  assert.equal(readFileAtCommit(repoRoot, second, "logo.png"), undefined);
});

test("readFileAtCommit refuses anything that is not a commit id", () => {
  const { repoRoot } = repoWithTwoCommits();

  assert.equal(readFileAtCommit(repoRoot, "HEAD", "src/app.tsx"), undefined);
  assert.equal(readFileAtCommit(repoRoot, "--upload-pack=touch", "src/app.tsx"), undefined);
});

test("readDiffBetween returns one file's diff between two commits", () => {
  const { repoRoot, first, second } = repoWithTwoCommits();

  const read = readDiffBetween(repoRoot, first, second, ["src/app.tsx"]);

  assert.equal(read.state, "patch");
  assert.match(patchOf(read), /-const a = 1;/);
  assert.match(patchOf(read), /\+const b = 3;/);
});

test("readDiffBetween reports an untouched file as an empty diff, not a failure", () => {
  const { repoRoot, first, second } = repoWithTwoCommits();

  assert.deepEqual(readDiffBetween(repoRoot, first, second, ["src/missing.ts"]), {
    state: "patch",
    patch: "",
  });
});

test("a patch too large for the read buffer is reported as oversize, not as a lost commit", () => {
  // Both commits are right there: calling this "unreachable" would tell the
  // reviewer git had lost one of them, when the only problem was the size.
  const repoRoot = newRepo("lsr-huge-");
  writeFileSync(join(repoRoot, "big.txt"), "first\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "first");
  const first = git(repoRoot, "rev-parse", "HEAD");
  writeFileSync(join(repoRoot, "big.txt"), `${"a line of replacement text\n".repeat(120_000)}`);
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "second");

  const read = readDiffBetween(repoRoot, first, git(repoRoot, "rev-parse", "HEAD"), ["big.txt"]);

  assert.deepEqual(read, { state: "oversize" });
  assert.ok(MAX_FILE_BYTES > 0, "the buffer this outgrew is the file cap");
});

test("readDiffBetween reports an unreachable commit as unreachable", () => {
  const { repoRoot, first } = repoWithTwoCommits();

  assert.deepEqual(readDiffBetween(repoRoot, first, "0".repeat(40), ["src/app.tsx"]), {
    state: "unreachable",
  });
  assert.deepEqual(readDiffBetween(repoRoot, "HEAD", first, ["src/app.tsx"]), {
    state: "unreachable",
  });
});

/** The patch of a read that produced one; anything else fails the assertion. */
function patchOf(read: DiffBetween): string {
  assert.equal(read.state, "patch");
  return read.state === "patch" ? read.patch : "";
}
