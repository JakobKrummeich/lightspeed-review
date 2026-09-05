import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewError } from "../src/errors.ts";
import { findRepoRoot, repoRef } from "../src/repo.ts";

test("finds the repository root from a directory inside the repository", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "lsr-repo-")));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });

  assert.equal(findRepoRoot(repo), repo);
});

test("a directory outside any repository fails with git_repo_not_found", () => {
  const plain = mkdtempSync(join(tmpdir(), "lsr-plain-"));

  assert.throws(
    () => findRepoRoot(plain),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "git_repo_not_found");
      return true;
    },
  );
});

test("a repo reference names the repository after its directory", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "lsr-ref-")));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });

  const reference = repoRef(repo);

  assert.equal(reference.root, repo);
  assert.equal(reference.name, repo.split("/").at(-1));
  assert.equal(reference.remote, null);
});

test("a repo reference normalises an ssh remote to host/path", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "lsr-ref-")));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:o/app.git"], { cwd: repo });

  assert.equal(repoRef(repo).remote, "github.com/o/app");
});

test("a repo reference normalises an https remote to host/path", () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "lsr-ref-")));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/o/app.git"], { cwd: repo });

  assert.equal(repoRef(repo).remote, "github.com/o/app");
});

test("a repo reference of a directory that is not a repository still has a name", () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "lsr-plain-")));

  assert.deepEqual(repoRef(plain), {
    root: plain,
    name: plain.split("/").at(-1),
    remote: null,
  });
});
