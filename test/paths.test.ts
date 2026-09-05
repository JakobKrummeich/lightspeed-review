import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  adoptFormerStateDir,
  expandHome,
  feedbackDirPath,
  sessionFilePath,
  sessionKey,
} from "../src/paths.ts";

test("session key is a 16 character hex digest", () => {
  const key = sessionKey("/repo", "feature-auth", "main");

  assert.match(key, /^[0-9a-f]{16}$/);
});

test("session key is stable for the same repo, branch and base", () => {
  assert.equal(
    sessionKey("/repo", "feature-auth", "main"),
    sessionKey("/repo", "feature-auth", "main"),
  );
});

test("session key separates repo, branch and base so concatenations cannot collide", () => {
  assert.notEqual(sessionKey("/repo", "a:b", "main"), sessionKey("/repo:a", "b", "main"));
});

test("session key differs per base branch", () => {
  assert.notEqual(
    sessionKey("/repo", "feature-auth", "main"),
    sessionKey("/repo", "feature-auth", "develop"),
  );
});

test("expandHome resolves a leading tilde", () => {
  assert.equal(expandHome("~/state"), join(homedir(), "state"));
});

test("expandHome leaves absolute paths untouched", () => {
  assert.equal(expandHome("/var/lib/state"), "/var/lib/state");
});

test("expandHome does not expand a tilde inside the path", () => {
  assert.equal(expandHome("/var/~/state"), "/var/~/state");
});

test("the feedback ledger lives in one directory of the state dir, shared by all repos", () => {
  assert.equal(feedbackDirPath("/state"), "/state/feedback");
});

test("session files live in a sessions subdirectory of the state dir", () => {
  assert.equal(
    sessionFilePath("/state", "a3f8c21b9e4d5f60"),
    "/state/sessions/a3f8c21b9e4d5f60.json",
  );
});

test("state left under the old name is adopted once, and never over existing state", () => {
  const home = mkdtempSync(join(tmpdir(), "lsr-home-"));
  const former = join(home, ".lightspeed-review");
  const current = join(home, ".lightspeed");
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(former, "sessions"), { recursive: true });
    writeFileSync(join(former, "sessions", "a.json"), "{}");

    adoptFormerStateDir(current);

    assert.equal(existsSync(join(current, "sessions", "a.json")), true, "the ledger moved");
    assert.equal(existsSync(former), false, "and nothing was left behind");

    // A second run has state of its own now, so the old name is left alone.
    mkdirSync(former, { recursive: true });
    writeFileSync(join(former, "stale.json"), "{}");
    adoptFormerStateDir(current);
    assert.equal(existsSync(join(former, "stale.json")), true, "existing state is never replaced");
  } finally {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
