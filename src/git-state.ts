import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * What a `reply` from `working` is measured against (W2): the branch tip and
 * the working tree where `work` found them. `tree` is a hash of `git status
 * --porcelain`, so a tree already dirty at `work` — a scratch file, an
 * unrelated edit — is not read as half-written code; only a change since is.
 * Unreadable reads as "cannot vouch" — no head, no tree, not clean — so a
 * broken git refuses the reply rather than waving it through.
 */
export interface BranchState {
  head?: string;
  tree?: string;
  clean: boolean;
}

export function branchState(repoRoot: string, branch: string): BranchState {
  const head = quietGit(repoRoot, ["rev-parse", `${branch}^{commit}`])?.trim();
  const status = quietGit(repoRoot, ["status", "--porcelain"]);
  return {
    ...(head ? { head } : {}),
    ...(status === undefined ? {} : { tree: createHash("sha256").update(status).digest("hex") }),
    clean: status !== undefined && status.trim() === "",
  };
}

function quietGit(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}
