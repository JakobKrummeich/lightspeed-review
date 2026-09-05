import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What the state directory was called before the tool was renamed. */
function formerStateDir(): string {
  return join(homedir(), ".lightspeed-review");
}

/**
 * Moves state left under the old name so the rename does not orphan sessions
 * and the feedback ledger. Fires only when old exists and new does not — a
 * no-op after the first run. A failed move is not worth crashing over.
 */
export function adoptFormerStateDir(stateDir: string): void {
  const former = formerStateDir();
  if (stateDir === former) return;
  if (existsSync(stateDir) || !existsSync(former)) return;
  try {
    renameSync(former, stateDir);
  } catch {
    // Left where it is; nothing here is worth failing a review over.
  }
}

/** Expands a leading `~/` only; a tilde elsewhere in the path is literal. The
 * home directory is a parameter so a test can point it at a temporary one
 * instead of rewriting the files of whoever runs the suite. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (!path.startsWith("~/")) return path;
  return join(home, path.slice(2));
}

/**
 * Identity of a review session. The separator makes `("/repo:a", "b")` and
 * `("/repo", "a:b")` distinct inputs, so keys cannot collide by concatenation.
 */
export function sessionKey(repoRoot: string, branch: string, base: string): string {
  return createHash("sha256")
    .update(`${repoRoot}\u0000${branch}\u0000${base}`)
    .digest("hex")
    .slice(0, 16);
}

/** All session files live in one flat directory, named by session key. */
export function sessionsDirPath(stateDir: string): string {
  return join(stateDir, "sessions");
}

/**
 * The feedback ledger is global: one directory in `stateDir` shared by every
 * repository, because mining reads across repos.
 */
export function feedbackDirPath(stateDir: string): string {
  return join(stateDir, "feedback");
}

export function sessionFilePath(stateDir: string, key: string): string {
  return join(sessionsDirPath(stateDir), `${key}.json`);
}
