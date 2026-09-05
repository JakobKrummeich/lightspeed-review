import { execFileSync } from "node:child_process";

/**
 * Whole files feed browser highlighting beyond the diff. Past this size the
 * diff still renders, just without full-file context.
 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Commit-ish arguments are checked rather than trusted: they end up on a command line. */
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * File contents at a commit, or undefined when git cannot produce them (added,
 * deleted, renamed, binary, too big). All normal outcomes — none throws; the
 * caller falls back to the diff alone.
 */
export function readFileAtCommit(
  repoRoot: string,
  commit: string,
  path: string,
): string | undefined {
  if (!COMMIT_PATTERN.test(commit)) return undefined;
  let contents: Buffer;
  try {
    contents = execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: repoRoot,
      maxBuffer: MAX_FILE_BYTES + 1,
    });
  } catch {
    return undefined;
  }
  if (contents.length > MAX_FILE_BYTES) return undefined;
  // A NUL byte means binary content, which has no lines to highlight.
  if (contents.includes(0)) return undefined;
  return contents.toString("utf8");
}

/**
 * Three answers, never folded: a patch (possibly empty), `oversize` (git answered,
 * too big for the buffer), `unreachable` (rebase/force-push/no repo). `oversize`
 * is why this is not `string | undefined` — reported as unknowable it would tell
 * the reviewer their commit went missing when the only problem was size.
 */
export type DiffBetween =
  { state: "patch"; patch: string } | { state: "oversize" } | { state: "unreachable" };

/**
 * Paths two commits differ in, under the newer commit's names; `unknowable` when
 * git cannot say. The list is complete when given at all: a path not in it was
 * verifiably untouched, which is what lets a caller reject it.
 */
export type DiffNames = { state: "files"; files: string[] } | { state: "unknowable" };

export function listDiffNames(repoRoot: string, from: string, to: string): DiffNames {
  if (!COMMIT_PATTERN.test(from) || !COMMIT_PATTERN.test(to)) return { state: "unknowable" };
  try {
    // `-z`: raw NUL-separated paths, so names with spaces/non-ASCII arrive unquoted.
    const out = execFileSync("git", ["diff", "--name-only", "--find-renames", "-z", from, to], {
      cwd: repoRoot,
      maxBuffer: MAX_FILE_BYTES + 1,
    });
    return { state: "files", files: out.toString("utf8").split("\0").filter(Boolean) };
  } catch {
    return { state: "unknowable" };
  }
}

/**
 * The patch between two commits. Renames are followed, which is why a caller
 * passes every name the file has had rather than only today's.
 */
export function readDiffBetween(
  repoRoot: string,
  from: string,
  to: string,
  paths: string[],
): DiffBetween {
  if (!COMMIT_PATTERN.test(from) || !COMMIT_PATTERN.test(to)) return { state: "unreachable" };
  try {
    const patch = execFileSync("git", ["diff", "--find-renames", from, to, "--", ...paths], {
      cwd: repoRoot,
      maxBuffer: MAX_FILE_BYTES + 1,
    });
    return { state: "patch", patch: patch.toString("utf8") };
  } catch (error) {
    return overlong(error) ? { state: "oversize" } : { state: "unreachable" };
  }
}

/**
 * Patch outgrew the buffer vs git failed: Node reports the former as `ENOBUFS`
 * with partial output. The salvaged half is dropped — a patch past
 * `MAX_FILE_BYTES` is not renderable anyway.
 */
function overlong(error: unknown): boolean {
  return (error as { code?: string }).code === "ENOBUFS";
}
