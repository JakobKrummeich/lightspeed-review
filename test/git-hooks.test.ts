import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, newRepo } from "./helpers/git-repo.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const UGLY = "const x = {a:1,b:[1,2]}\n";
const PRETTY = "const x = { a: 1, b: [1, 2] };\n";

/** A repository with this repo's pre-commit hook and prettier setup, so a commit
 * in it behaves like a commit in a contributor's checkout. */
function hookedRepo({ withPrettier = true } = {}): string {
  const repo = newRepo("lsr-hook-");
  cpSync(join(repoRoot, ".githooks"), join(repo, ".githooks"), { recursive: true });
  cpSync(join(repoRoot, ".prettierrc"), join(repo, ".prettierrc"));
  if (withPrettier) symlinkSync(join(repoRoot, "node_modules"), join(repo, "node_modules"));
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git(repo, "config", "core.hooksPath", ".githooks");
  git(repo, "config", "commit.gpgsign", "false");
  return repo;
}

/** Commits and returns stderr: the hook speaks there, and a failed commit throws. */
function commit(repo: string): string {
  const result = spawnSync("git", ["commit", "--quiet", "-m", "change"], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stderr;
}

const committed = (repo: string, path: string) => git(repo, "show", `HEAD:${path}`) + "\n";

test("the pre-commit hook formats a staged file and commits the formatted version", () => {
  const repo = hookedRepo();
  writeFileSync(join(repo, "a.ts"), UGLY);
  git(repo, "add", ".");

  commit(repo);

  assert.equal(committed(repo, "a.ts"), PRETTY);
  assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), PRETTY);
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("the pre-commit hook formats a file whose name has a space in it", () => {
  const repo = hookedRepo();
  writeFileSync(join(repo, "a b.ts"), UGLY);
  git(repo, "add", ".");

  commit(repo);

  assert.equal(committed(repo, "a b.ts"), PRETTY);
});

/** Formatting a partially staged file and re-adding it would sweep the unstaged
 * hunks into the commit: the hook leaves such a file exactly as staged. */
test("the pre-commit hook leaves a partially staged file alone and says so", () => {
  const repo = hookedRepo();
  writeFileSync(join(repo, "a.ts"), UGLY);
  git(repo, "add", ".");
  writeFileSync(join(repo, "a.ts"), UGLY + "const unstaged = 1\n");

  const stderr = commit(repo);

  assert.equal(committed(repo, "a.ts"), UGLY);
  assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), UGLY + "const unstaged = 1\n");
  assert.match(stderr, /a\.ts has unstaged changes/);
});

test("the pre-commit hook still formats the fully staged files beside a partially staged one", () => {
  const repo = hookedRepo();
  writeFileSync(join(repo, "a.ts"), UGLY);
  writeFileSync(join(repo, "b.ts"), UGLY);
  git(repo, "add", ".");
  writeFileSync(join(repo, "a.ts"), UGLY + "const unstaged = 1\n");

  commit(repo);

  assert.equal(committed(repo, "a.ts"), UGLY);
  assert.equal(committed(repo, "b.ts"), PRETTY);
});

test("the pre-commit hook commits files prettier has no parser for unchanged", () => {
  const repo = hookedRepo();
  writeFileSync(join(repo, "notes.unknown"), "a   b\n");
  git(repo, "add", ".");

  commit(repo);

  assert.equal(committed(repo, "notes.unknown"), "a   b\n");
});

/** The hook is a convenience, CI's format:check is the gate: a file prettier
 * cannot parse is committed as it is rather than blocking the commit. */
test("the pre-commit hook lets a commit through when prettier cannot parse a file", () => {
  const repo = hookedRepo();
  writeFileSync(join(repo, "broken.ts"), "const = = ;\n");
  writeFileSync(join(repo, "b.ts"), UGLY);
  git(repo, "add", ".");

  commit(repo);

  assert.equal(committed(repo, "broken.ts"), "const = = ;\n");
  assert.equal(committed(repo, "b.ts"), PRETTY);
});

test("the pre-commit hook lets a commit through untouched when prettier is not installed", () => {
  const repo = hookedRepo({ withPrettier: false });
  writeFileSync(join(repo, "a.ts"), UGLY);
  git(repo, "add", ".");

  const stderr = commit(repo);

  assert.equal(committed(repo, "a.ts"), UGLY);
  assert.match(stderr, /prettier/);
});

/** Runs the hook wiring the way `prepare` does: from the package root. */
function runHookWiring(packageDir: string): void {
  mkdirSync(packageDir, { recursive: true });
  // Without the machine's global config: a contributor's own global hooks path
  // would otherwise read as one already set.
  execFileSync("node", [join(repoRoot, "scripts/git-hooks.ts")], {
    cwd: packageDir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

const hooksPath = (repo: string) =>
  spawnSync("git", ["config", "--local", "core.hooksPath"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();

test("installing in a checkout points git at the committed hooks", () => {
  const repo = newRepo("lsr-wire-");

  runHookWiring(repo);

  assert.equal(hooksPath(repo), ".githooks");
});

/** A package directory that is not its repository's root is a dependency inside
 * someone else's repository: their hooks are not this package's to rewire. */
test("installing inside another repository leaves that repository's hooks alone", () => {
  const outer = newRepo("lsr-outer-");
  const packageDir = join(outer, "node_modules", "lightspeed-review");

  runHookWiring(packageDir);

  assert.equal(hooksPath(outer), "");
});

/** The no-mistakes gate points core.hooksPath at the hooks it runs on; an
 * install in one of its worktrees must not unhook it. */
test("installing in a checkout whose hooks path is already set keeps that path", () => {
  const repo = newRepo("lsr-taken-");
  git(repo, "config", "core.hooksPath", "/elsewhere/hooks");

  runHookWiring(repo);

  assert.equal(hooksPath(repo), "/elsewhere/hooks");
});

test("installing outside any git checkout succeeds without wiring anything", () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "lsr-nogit-")));

  runHookWiring(plain);

  assert.equal(existsSync(join(plain, ".git")), false);
});
