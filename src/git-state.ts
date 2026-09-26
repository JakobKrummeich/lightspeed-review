import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What a `reply` from `working` is measured against (W2): the branch tip and
 * the working tree where `work` found them. `tree` hashes the tree's content —
 * every tracked change against HEAD plus each untracked file's name and bytes —
 * so a tree already dirty at `work` (a scratch file, an unrelated edit) is not
 * read as half-written code, while any edit since is, even to a file that was
 * dirty already. Unreadable reads as "cannot vouch" — no head, no tree — so a
 * broken git refuses the reply rather than waving it through.
 */
export interface BranchState {
  head?: string;
  tree?: string;
}

export function branchState(repoRoot: string, branch: string): BranchState {
  const head = quietGit(repoRoot, ["rev-parse", `${branch}^{commit}`])?.trim();
  const tree = treeHash(repoRoot);
  return {
    ...(head ? { head } : {}),
    ...(tree === undefined ? {} : { tree }),
  };
}

const DIFF = ["diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--no-textconv"];

function treeHash(repoRoot: string): string | undefined {
  const tracked = quietGit(repoRoot, DIFF);
  const untracked = quietGit(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  if (tracked === undefined || untracked === undefined) return undefined;
  const hash = createHash("sha256").update(tracked);
  for (const path of untracked.split("\0").filter(Boolean)) {
    hash.update(`\0${path}\0${contentHash(join(repoRoot, path))}`);
  }
  return hash.digest("hex");
}

/** A file that cannot be read still counts as there: its name is in the hash. */
function contentHash(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "unreadable";
  }
}

/** Whether `name` resolves to a commit here: a branch, a tag, a sha. */
export function isCommit(repoRoot: string, name: string): boolean {
  return quietGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]) !== undefined;
}

/**
 * The branch's own work since the round the reviewer last saw: commits on `tip`
 * that neither `published` nor `base` has, merges left out, and a commit whose
 * patch the published history already carries left out too. A plain `from..tip`
 * counted every commit a merge of main brought in, and every published commit a
 * rebase onto main rewrote, as work nobody reviewed. Unknown — a ref gone, no
 * repo — is `undefined`, never 0, so a caller claims nothing either way.
 */
export function unpublishedCommits(
  repoRoot: string,
  refs: { published: string; tip: string; base: string },
): number | undefined {
  const count = quietGit(repoRoot, [
    "rev-list",
    "--count",
    "--no-merges",
    "--right-only",
    "--cherry-pick",
    `${refs.published}...${refs.tip}`,
    "--not",
    refs.base,
    "--",
  ])?.trim();
  return count === undefined || count === "" ? undefined : Number(count);
}

/** git's answer, or `undefined` for any failure: callers treat unknown as "cannot vouch". */
export function quietGit(repoRoot: string, args: string[]): string | undefined {
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
