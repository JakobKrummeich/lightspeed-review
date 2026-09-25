import { execFileSync } from "node:child_process";

/**
 * What a `reply` from `working` is measured against (W2): the branch tip where
 * `work` found it, and a tree with nothing half-written in it. Unreadable reads
 * as "cannot vouch" — no head, not clean — so a broken git refuses the reply
 * rather than waving it through.
 */
export interface BranchState {
  head?: string;
  clean: boolean;
}

export function branchState(repoRoot: string, branch: string): BranchState {
  const head = quietGit(repoRoot, ["rev-parse", `${branch}^{commit}`])?.trim();
  const status = quietGit(repoRoot, ["status", "--porcelain"]);
  return { ...(head ? { head } : {}), clean: status !== undefined && status.trim() === "" };
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
