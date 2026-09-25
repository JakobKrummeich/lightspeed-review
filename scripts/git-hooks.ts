// Points git at the committed hooks in .githooks/ — run by `prepare`, so every
// `pnpm install` in a checkout wires them in with no step to remember.
//
// Only when this package is its repository's root: a package directory inside
// another repository is a dependency being installed there, and that
// repository's hooks are not ours to rewire. Outside git (a tarball) there is
// nothing to wire, and an install must never fail over a convenience.
//
// Never over a hooks path already set: someone else owns the hooks then. The
// no-mistakes gate is one — its run worktrees share config with a bare repository
// whose core.hooksPath points at the pre-/post-receive hooks the gate runs on, and
// an install in such a worktree must not unhook the gate.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

// npm and pnpm run lifecycle scripts from the package root.
const packageRoot = realpathSync(process.cwd());

const git = (...args: string[]) =>
  spawnSync("git", args, {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const topLevel = git("rev-parse", "--show-toplevel");
const isRepositoryRoot =
  topLevel.status === 0 && realpathSync(topLevel.stdout.trim()) === packageRoot;
const hooksPathTaken = git("config", "--get", "core.hooksPath").status === 0;
if (isRepositoryRoot && !hooksPathTaken) {
  git("config", "core.hooksPath", ".githooks");
}
