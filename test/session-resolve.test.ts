import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewError } from "../src/errors.ts";
import { resolveSession } from "../src/session-resolve.ts";
import type { SessionRecord } from "../src/session-store.ts";

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    key: "key",
    repoRoot: "/repo",
    branch: "feature-auth",
    base: "main",
    status: "open",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    groups: [],
    conversation: [],
    pending: [],
    approved: [],
    rounds: [],
    ...overrides,
  };
}

test("an explicit branch wins over anything stored", () => {
  const sessions = [session({ branch: "other" })];

  assert.deepEqual(resolveSession(sessions, "/repo", "feature-auth", "develop"), {
    branch: "feature-auth",
    base: "develop",
  });
});

test("an explicit branch without a base falls back to main", () => {
  assert.deepEqual(resolveSession([], "/repo", "feature-auth", undefined), {
    branch: "feature-auth",
    base: "main",
  });
});

test("with one live session in this repository the branch may be omitted", () => {
  const sessions = [
    session({ branch: "feature-auth", base: "develop" }),
    session({ repoRoot: "/elsewhere", branch: "other" }),
    session({ branch: "old", status: "ended" }),
  ];

  assert.deepEqual(resolveSession(sessions, "/repo", undefined, undefined), {
    branch: "feature-auth",
    base: "develop",
  });
});

test("no session in this repository is an ambiguous_session error", () => {
  assert.throws(
    () => resolveSession([session({ repoRoot: "/elsewhere" })], "/repo", undefined, undefined),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "ambiguous_session");
      return true;
    },
  );
});

test("several live sessions list the candidates instead of guessing", () => {
  const sessions = [
    session({ branch: "feature-auth", base: "main" }),
    session({ branch: "fix-billing", base: "develop" }),
  ];

  assert.throws(
    () => resolveSession(sessions, "/repo", undefined, undefined),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "ambiguous_session");
      assert.match(error.detail ?? "", /feature-auth main/);
      assert.match(error.detail ?? "", /fix-billing develop/);
      return true;
    },
  );
});
