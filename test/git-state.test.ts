import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { unpublishedCommits } from "../src/git-state.ts";
import { git, newRepo } from "./helpers/git-repo.ts";

function commitFile(repoRoot: string, name: string): string {
  writeFileSync(join(repoRoot, name), `${name}\n`);
  git(repoRoot, "add", name);
  git(repoRoot, "commit", "-q", "-m", name);
  return git(repoRoot, "rev-parse", "HEAD");
}

function branchAtRound(): { repoRoot: string; published: string } {
  const repoRoot = newRepo("lsr-git-state-");
  commitFile(repoRoot, "base.txt");
  git(repoRoot, "checkout", "-q", "-b", "feat");
  return { repoRoot, published: commitFile(repoRoot, "round.txt") };
}

test("counts the branch's own new commits since the published tip", () => {
  const { repoRoot, published } = branchAtRound();
  commitFile(repoRoot, "a.txt");
  commitFile(repoRoot, "b.txt");

  assert.equal(unpublishedCommits(repoRoot, { published, tip: "feat", base: "main" }), 2);
});

/** Unknown is not zero: the caller must not claim either way. */
test("a branch, base or published tip git cannot resolve counts as unknown", () => {
  const { repoRoot, published } = branchAtRound();

  assert.equal(unpublishedCommits(repoRoot, { published, tip: "gone", base: "main" }), undefined);
  assert.equal(unpublishedCommits(repoRoot, { published, tip: "feat", base: "gone" }), undefined);
  assert.equal(
    unpublishedCommits(repoRoot, { published: "f".repeat(40), tip: "feat", base: "main" }),
    undefined,
  );
});
