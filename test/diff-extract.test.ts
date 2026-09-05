import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffStats,
  extractDiff,
  parseDiff,
  splitHunks,
  type DiffFile,
  type DiffHunk,
} from "../src/diff-extract.ts";
import { ReviewError } from "../src/errors.ts";
import { git as fixtureGit, newRepo } from "./helpers/git-repo.ts";

const sampleDiff = readFileSync(new URL("./fixtures/sample.diff", import.meta.url), "utf8");

function fileByPath(files: DiffFile[], path: string): DiffFile {
  const file = files.find((candidate) => candidate.path === path);
  assert.ok(file, `no diff entry for ${path}`);
  return file;
}

test("parseDiff finds every changed file in the diff", () => {
  const files = parseDiff(sampleDiff);

  assert.deepEqual(
    files.map((file) => file.path),
    [
      "src/api/users.ts",
      "src/api/orders.ts",
      "src/legacy/helper.ts",
      "docs/manual.md",
      "assets/logo.png",
    ],
  );
});

test("parseDiff counts insertions and deletions per file, ignoring hunk headers", () => {
  const users = fileByPath(parseDiff(sampleDiff), "src/api/users.ts");

  assert.equal(users.insertions, 3);
  assert.equal(users.deletions, 2);
});

test("parseDiff classifies added, deleted, renamed and modified files", () => {
  const files = parseDiff(sampleDiff);

  assert.equal(fileByPath(files, "src/api/users.ts").status, "modified");
  assert.equal(fileByPath(files, "src/api/orders.ts").status, "added");
  assert.equal(fileByPath(files, "src/legacy/helper.ts").status, "deleted");
  assert.equal(fileByPath(files, "docs/manual.md").status, "renamed");
});

test("parseDiff remembers the name a renamed file used to have", () => {
  const files = parseDiff(sampleDiff);

  assert.equal(fileByPath(files, "docs/manual.md").previousPath, "docs/guide.md");
  assert.equal(fileByPath(files, "src/api/users.ts").previousPath, undefined);
});

test("parseDiff marks binary files and keeps no content for them", () => {
  const logo = fileByPath(parseDiff(sampleDiff), "assets/logo.png");

  assert.equal(logo.status, "binary");
  assert.equal(logo.diff, "");
  assert.equal(logo.insertions, 0);
  assert.equal(logo.deletions, 0);
});

test("parseDiff keeps the full unified diff for a text file", () => {
  const orders = fileByPath(parseDiff(sampleDiff), "src/api/orders.ts");

  assert.match(orders.diff, /^diff --git a\/src\/api\/orders\.ts/);
  assert.match(orders.diff, /\+export function listOrders\(\) \{/);
  assert.ok(!orders.diff.includes("src/legacy/helper.ts"));
});

test("parseDiff flags files whose diff exceeds 10k lines", () => {
  const hugeBody = Array.from({ length: 10_001 }, (_, index) => `+line ${index}`).join("\n");
  const diff = `diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,10001 @@\n${hugeBody}\n`;

  const [big] = parseDiff(diff);

  assert.equal(big?.oversized, true);
  assert.equal(fileByPath(parseDiff(sampleDiff), "src/api/users.ts").oversized, false);
});

test("parseDiff returns nothing for an empty diff", () => {
  assert.deepEqual(parseDiff(""), []);
});

test("parseDiff handles paths that git quotes because of spaces", () => {
  const diff = [
    'diff --git "a/src/my file.ts" "b/src/my file.ts"',
    '--- "a/src/my file.ts"',
    '+++ "b/src/my file.ts"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");

  assert.equal(parseDiff(diff)[0]?.path, "src/my file.ts");
});

function gitRepoWithBranch(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "lsr-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });

  git("init", "-b", "main");
  writeFileSync(join(repoRoot, "kept.txt"), "one\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  mkdirSync(join(repoRoot, "src"));
  writeFileSync(join(repoRoot, "src", "added.txt"), "new\n");
  writeFileSync(join(repoRoot, "kept.txt"), "one\ntwo\n");
  git("add", ".");
  git("commit", "-m", "work");
  return repoRoot;
}

test("extractDiff reads the merge-base diff between two real branches", () => {
  const repoRoot = gitRepoWithBranch();

  const { files, stats } = extractDiff(repoRoot, "feature", "main");

  assert.deepEqual(files.map((file) => file.path).sort(), ["kept.txt", "src/added.txt"]);
  assert.equal(stats.files_changed, 2);
  assert.equal(stats.insertions, 2);
  assert.equal(stats.deletions, 0);
  assert.equal(stats.binary_skipped, 0);
});

test("extractDiff resolves the merge base and the branch tip to commit ids", () => {
  const repoRoot = gitRepoWithBranch();
  const revision = (rev: string) =>
    execFileSync("git", ["rev-parse", rev], { cwd: repoRoot, encoding: "utf8" }).trim();

  const { baseCommit, headCommit } = extractDiff(repoRoot, "feature", "main");

  assert.equal(baseCommit, revision("main"));
  assert.equal(headCommit, revision("feature"));
});

test("extractDiff reads the branch's own commit subjects, newest first", () => {
  const repoRoot = gitRepoWithBranch();

  const { commits } = extractDiff(repoRoot, "feature", "main");

  // `base..branch`: the commit both branches share is not this branch's work.
  assert.deepEqual(commits, ["work"]);
});

test("diffStats counts binary files in binary_skipped", () => {
  const stats = diffStats(parseDiff(sampleDiff));

  assert.equal(stats.files_changed, 5);
  assert.equal(stats.binary_skipped, 1);
});

test("extractDiff reports git_ref_not_found for an unknown branch", () => {
  const repoRoot = gitRepoWithBranch();

  assert.throws(
    () => extractDiff(repoRoot, "does-not-exist", "main"),
    (error: unknown) => error instanceof ReviewError && error.code === "git_ref_not_found",
  );
});

test("extractDiff asks git for histogram diffs and rename detection", () => {
  const repoRoot = gitRepoWithBranch();
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  // A rename git only reports when asked for it: `diff.renames` may be off.
  git("mv", "kept.txt", "moved.txt");
  git("commit", "-m", "move it");

  const moved = fileByPath(extractDiff(repoRoot, "feature", "main").files, "moved.txt");

  assert.equal(moved.status, "renamed");
  assert.equal(moved.previousPath, "kept.txt");
  assert.ok((moved.similarity ?? 0) > 0, "git's own similarity index is carried");
});

test("a repeated closing line anchors on the inserted block, not on a blend of two", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "lsr-hist-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  const fn = (name: string) => `function ${name}() {\n  return ${name};\n}\n`;
  git("init", "-b", "main");
  writeFileSync(join(repoRoot, "a.js"), fn("one") + fn("three"));
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  writeFileSync(join(repoRoot, "a.js"), fn("one") + fn("two") + fn("three"));
  git("add", ".");
  git("commit", "-m", "insert a whole function");

  const { files } = extractDiff(repoRoot, "feature", "main");
  const added = files[0]!.diff
    .split("\n")
    .filter((line) => line.startsWith("+") && line[1] !== "+");

  // The whole function arrives as added lines; nothing is rewritten around it.
  assert.deepEqual(added, ["+function two() {", "+  return two;", "+}"]);
  assert.equal(files[0]?.deletions, 0);
});

/**
 * The invariant the cut exists to keep: `header`, then every hunk's `header`/`body`
 * in order, is the patch that went in — `git apply` needs git's bytes, not a reconstruction.
 */
function assertHunksJoinBackIntoTheDiff(files: DiffFile[], source: string): void {
  assert.ok(files.length > 0, `${source}: no files, so the round trip proves nothing`);
  for (const file of files) {
    const { header, hunks } = splitHunks(file.diff);
    const joined = header + hunks.map((hunk) => hunk.header + hunk.body).join("");
    assert.equal(joined, file.diff, `${source}: ${file.path} does not join back into its diff`);
  }
}

/** The per-hunk counts are a partition of the per-file ones, never a second opinion. */
function assertHunkCountsSumToTheFile(files: DiffFile[], source: string): void {
  assert.ok(files.length > 0, `${source}: no files, so the counts prove nothing`);
  for (const file of files) {
    const { hunks } = splitHunks(file.diff);
    const sum = (pick: (hunk: DiffHunk) => number) =>
      hunks.reduce((total, hunk) => total + pick(hunk), 0);
    assert.equal(
      sum((hunk) => hunk.insertions),
      file.insertions,
      `${source}: ${file.path} +`,
    );
    assert.equal(
      sum((hunk) => hunk.deletions),
      file.deletions,
      `${source}: ${file.path} -`,
    );
  }
}

const twoHunkDiff = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,5 +1,6 @@ import { boot } from './boot.ts';",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -20,4 +21,3 @@ function run() {",
  " keep",
  "-drop",
  " tail",
  "",
].join("\n");

test("splitHunks cuts a modification into its hunks, with the file header above them", () => {
  const files = parseDiff(twoHunkDiff);
  const { header, hunks } = splitHunks(files[0]?.diff ?? "");

  assert.equal(
    header,
    "diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n",
  );
  assert.deepEqual(
    hunks.map((hunk) => hunk.header),
    ["@@ -1,5 +1,6 @@ import { boot } from './boot.ts';\n", "@@ -20,4 +21,3 @@ function run() {\n"],
  );
  assert.equal(
    hunks[0]?.body,
    " const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n const d = 5;\n",
  );
  assert.equal(hunks[1]?.body, " keep\n-drop\n tail");
  assert.deepEqual(
    hunks.map((hunk) => [hunk.insertions, hunk.deletions]),
    [
      [2, 1],
      [0, 1],
    ],
  );
  assertHunksJoinBackIntoTheDiff(files, "two-hunk diff");
});

test("every file of the sample diff joins back into its diff, byte for byte", () => {
  assertHunksJoinBackIntoTheDiff(parseDiff(sampleDiff), "sample.diff");
});

test("insertions and deletions summed over the hunks are the file's own", () => {
  const files = parseDiff(sampleDiff);

  assertHunkCountsSumToTheFile(files, "sample.diff");
  assert.deepEqual(
    splitHunks(fileByPath(files, "src/api/users.ts").diff).hunks.map((hunk) => [
      hunk.insertions,
      hunk.deletions,
    ]),
    [[3, 2]],
  );
});

test("an added file and a deleted file each come back as one hunk", () => {
  const files = parseDiff(sampleDiff);
  const added = splitHunks(fileByPath(files, "src/api/orders.ts").diff);

  assert.equal(added.hunks.length, 1);
  assert.equal(added.header.endsWith("+++ b/src/api/orders.ts\n"), true);
  assert.equal(splitHunks(fileByPath(files, "src/legacy/helper.ts").diff).hunks[0]?.deletions, 2);
});

test("a binary file has no header and no hunks, because it has no diff", () => {
  const logo = splitHunks(fileByPath(parseDiff(sampleDiff), "assets/logo.png").diff);

  assert.equal(logo.header, "");
  assert.deepEqual(logo.hunks, []);
});

test("a hunk header is read by its shape, not by any line beginning with @@", () => {
  const diff = [
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,3 +1,4 @@ ## Reading a patch",
    " A header looks like this:",
    "+@@ -1,2 +1,2 @@ but this line is content",
    "-@@ -9,9 +9,9 @@",
    " and it says which lines moved.",
    "",
  ].join("\n");

  const notes = splitHunks(parseDiff(diff)[0]?.diff ?? "");

  assert.equal(notes.hunks.length, 1);
  assert.equal(notes.hunks[0]?.insertions, 1);
  assert.equal(notes.hunks[0]?.deletions, 1);
  assertHunksJoinBackIntoTheDiff(parseDiff(diff), "@@ inside a hunk body");
});

/**
 * Two lines beginning `@@` that are not hunk headers of ours: a splitter keyed on
 * "starts with @@" cuts both. The marker-column test misses this — its decoys begin `+`/`-`.
 */
const combinedDiff = [
  "diff --cc src/app.ts",
  "index 1111111,2222222..3333333",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@@ -1,2 -1,2 +1,3 @@@",
  "  keep",
  " +one side changed it",
  "++both sides changed it",
].join("\n");

test("a combined diff has no hunks of ours, and loses no line to saying so", () => {
  const combined = splitHunks(combinedDiff);

  assert.deepEqual(combined.hunks, []);
  assert.equal(combined.header, combinedDiff);
});

test("a header that lost its closing @@ is not read as a hunk header", () => {
  const malformed = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,2 +3,4@@", "-old", "+new"].join("\n");

  const cut = splitHunks(malformed);

  assert.deepEqual(cut.hunks, []);
  assert.equal(cut.header, malformed);
});

/**
 * One file of every diff shape git emits (two-hunk modification, add, delete, pure rename,
 * binary, no-newline, decoy `@@` patch file). Git's own output, built once for three tests.
 */
function repoWithEveryDiffShape(): string {
  everyDiffShape ??= buildRepoWithEveryDiffShape();
  return everyDiffShape;
}

let everyDiffShape: string | undefined;

after(() => {
  if (everyDiffShape !== undefined) rmSync(everyDiffShape, { recursive: true, force: true });
});

function buildRepoWithEveryDiffShape(): string {
  const repoRoot = newRepo("lsr-hunks-");
  const write = (name: string, contents: string | Buffer) =>
    writeFileSync(join(repoRoot, name), contents);
  const spaced = (first: string, last: string) =>
    [first, ...Array.from({ length: 12 }, (_, index) => `line ${index}`), last].join("\n") + "\n";
  const patch = (removal: string, header: string) =>
    [
      "diff --git a/one.txt b/one.txt",
      "@@ -1,2 +1,2 @@",
      " kept",
      removal,
      "+new",
      header,
      " tail",
      "",
    ].join("\n");

  mkdirSync(join(repoRoot, "docs"));
  write("app.ts", spaced("const top = 1;", "const bottom = 1;"));
  write("legacy.ts", "export const gone = true;\n");
  write("docs/guide.md", "# Guide\n");
  write("docs/patch.diff", patch("-old", "@@ -9,1 +9,1 @@"));
  write("bare.txt", "no newline here");
  fixtureGit(repoRoot, "add", ".");
  fixtureGit(repoRoot, "commit", "-m", "base");

  fixtureGit(repoRoot, "checkout", "-b", "feature");
  write("app.ts", spaced("const top = 2;", "const bottom = 2;"));
  write("notes.md", "# Notes\n");
  write("docs/patch.diff", patch("-older", "@@ -9,2 +9,2 @@"));
  write("bare.txt", "still no newline");
  write("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  fixtureGit(repoRoot, "rm", "-q", "legacy.ts");
  fixtureGit(repoRoot, "mv", "docs/guide.md", "docs/manual.md");
  fixtureGit(repoRoot, "add", "-A");
  fixtureGit(repoRoot, "commit", "-m", "one of everything");
  return repoRoot;
}

test("real git output of every diff shape joins back and counts up", () => {
  const { files } = extractDiff(repoWithEveryDiffShape(), "feature", "main");

  assertHunksJoinBackIntoTheDiff(files, "git output");
  assertHunkCountsSumToTheFile(files, "git output");
  assert.equal(splitHunks(fileByPath(files, "app.ts").diff).hunks.length, 2);
  assert.deepEqual(fileByPath(files, "notes.md").status, "added");
  assert.deepEqual(fileByPath(files, "legacy.ts").status, "deleted");
});

test("a file with no newline at its end keeps git's marker inside the hunk", () => {
  const { files } = extractDiff(repoWithEveryDiffShape(), "feature", "main");

  const bare = splitHunks(fileByPath(files, "bare.txt").diff);

  assert.equal(bare.hunks.length, 1);
  // The marker belongs to the line above it, so it is body, never a hunk of its own.
  assert.equal(bare.hunks[0]?.body.includes("\\ No newline at end of file"), true);
});

test("a binary file from git has nothing to cut", () => {
  const { files } = extractDiff(repoWithEveryDiffShape(), "feature", "main");

  const logo = fileByPath(files, "logo.png");

  assert.equal(logo.status, "binary");
  assert.deepEqual(splitHunks(logo.diff), { header: "", hunks: [] });
});

test("a rename with no edits is header alone, and still joins back into its diff", () => {
  const { files } = extractDiff(repoWithEveryDiffShape(), "feature", "main");

  const renamed = fileByPath(files, "docs/manual.md");
  const cut = splitHunks(renamed.diff);

  assert.deepEqual(cut.hunks, []);
  assert.equal(cut.header, renamed.diff);
  assert.match(cut.header, /rename to docs\/manual\.md/);
});

test("a patch file's own @@ lines stay inside the hunk that changed them", () => {
  const { files } = extractDiff(repoWithEveryDiffShape(), "feature", "main");

  const patch = splitHunks(fileByPath(files, "docs/patch.diff").diff);

  assert.equal(patch.hunks.length, 1);
  assert.equal(patch.header.endsWith("+++ b/docs/patch.diff\n"), true);
  assert.ok(patch.hunks[0]?.body.includes("\n @@ -1,2 +1,2 @@\n"), "a context @@ line stays put");
  assert.ok(patch.hunks[0]?.body.includes("\n-@@ -9,1 +9,1 @@\n"), "a removed @@ line stays put");
  assert.ok(patch.hunks[0]?.body.includes("\n+@@ -9,2 +9,2 @@\n"), "an added @@ line stays put");
});

test("a changed line that begins with ++ or -- is counted by neither the file nor its hunks", () => {
  // A changed line opening `--`/`++` reads as a file header: counted by nobody (numstat says 1/1).
  // Hunks inherit the undercount deliberately — a hunk disagreeing with its file is worse.
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    "--- a dashed line",
    "+++ a plussed line",
    " keep",
    "",
  ].join("\n");

  const [dashed] = parseDiff(diff);

  assert.equal(dashed?.insertions, 0);
  assert.equal(dashed?.deletions, 0);
  assertHunkCountsSumToTheFile(parseDiff(diff), "content that looks like a file header");
});
