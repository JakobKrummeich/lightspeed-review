import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { ReviewError } from "./errors.ts";
import type { RepoRef } from "./ledger/records.ts";

/**
 * How a repository is identified inside the global feedback ledger. The remote
 * is best effort: a repo without one, or a directory git refuses to answer for,
 * still has a usable name, and no ledger write may fail over it.
 */
export function repoRef(repoRoot: string): RepoRef {
  return {
    root: repoRoot,
    name: basename(repoRoot),
    remote: normaliseRemote(readRemote(repoRoot)),
  };
}

function readRemote(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** `git@github.com:o/app.git` and `https://github.com/o/app.git` both become `github.com/o/app`. */
function normaliseRemote(url: string | undefined): string | null {
  if (url === undefined || url === "") return null;
  const withoutScheme = url.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
  return withoutScheme.replace(":", "/").replace(/\.git$/, "") || null;
}

/**
 * The repository a command applies to, or undefined when there is none. Only
 * the ledger reader uses this: everything else needs a repository, and saying
 * so with `git_repo_not_found` is more useful than carrying an absent one.
 */
export function repoRootOrNone(cwd: string): string | undefined {
  try {
    return findRepoRoot(cwd);
  } catch {
    return undefined;
  }
}

/**
 * The repository a command applies to. Sessions are keyed by repo root, so
 * this has to be the same string every command computes — `git` decides it,
 * not the caller's cwd.
 */
export function findRepoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    throw new ReviewError({
      code: "git_repo_not_found",
      message: `${cwd} is not inside a git repository`,
      detail: (error as Error).message,
      suggestions: [
        "Run the command from inside the repository you want reviewed",
        "Run `git rev-parse --show-toplevel` to check what git sees",
      ],
    });
  }
}
