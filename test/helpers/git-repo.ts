import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs git in a fixture repository with an identity, so commits never prompt. */
export function git(repoRoot: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

/** An empty repository on `main`, in a temporary directory. */
export function newRepo(prefix = "lsr-git-"): string {
  const repoRoot = mkdtempSync(join(tmpdir(), prefix));
  git(repoRoot, "init", "-b", "main");
  return repoRoot;
}
