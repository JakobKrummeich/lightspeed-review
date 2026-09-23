import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function formerStateDir(): string {
  return join(homedir(), ".lightspeed-review");
}

/** So the rename does not orphan sessions and the feedback ledger. */
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

/** A leading `~/` only; a tilde elsewhere is literal. `home` is a parameter so a
 * test can point it at a temporary directory. */
export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (!path.startsWith("~/")) return path;
  return join(home, path.slice(2));
}

/**
 * The separator makes `("/repo:a", "b")` and `("/repo", "a:b")` distinct
 * inputs, so keys cannot collide by concatenation.
 */
export function sessionKey(repoRoot: string, branch: string, base: string): string {
  return createHash("sha256")
    .update(`${repoRoot}\u0000${branch}\u0000${base}`)
    .digest("hex")
    .slice(0, 16);
}

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
