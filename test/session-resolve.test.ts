import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewError } from "../src/errors.ts";
import { missingSession, resolveSession } from "../src/session-resolve.ts";
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
    turn: { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

/**
 * Regression: the 404 named the session key — a hash the agent has never seen
 * printed anywhere — and offered a `<branch> [base]` template back.
 */
test("a review nothing holds is named by its branch pair and its repository", () => {
  const error = missingSession({
    repoRoot: "/repo",
    branch: "other/branch",
    base: "main",
    verb: "wait",
    sessions: [session({ branch: "feature/greeting", base: "main" })],
  });

  assert.equal(error.code, "session_not_found");
  assert.equal(error.message, "no review session for other/branch against main in /repo");
  assert.equal(error.detail, "1 live session in this repo: feature/greeting against main");
  assert.deepEqual(error.suggestions, [
    "Run `lightspeed open other/branch main --intent '<why this branch exists>'` to open it",
    "Or run `lightspeed wait feature/greeting main` for the session that exists",
  ]);
});

test("the session that exists is offered to the command that was actually run", () => {
  const error = missingSession({
    repoRoot: "/repo",
    branch: "other",
    base: "main",
    verb: "approvals",
    sessions: [session({ branch: "feature/greeting", base: "develop" })],
  });

  assert.match(error.suggestions[1] ?? "", /lightspeed approvals feature\/greeting develop/);
});

test("several live sessions are all named, and none of them is guessed at", () => {
  const error = missingSession({
    repoRoot: "/repo",
    branch: "other",
    base: "main",
    verb: "say",
    sessions: [session({ branch: "one" }), session({ branch: "two", base: "develop" })],
  });

  assert.equal(error.detail, "2 live sessions in this repo: one against main, two against develop");
  assert.match(error.suggestions[1] ?? "", /lightspeed say <branch> \[base\]/);
});

/** Ended reviews and other repositories' reviews are not sessions this command
 * could have meant, so they are not offered as ones it might have. */
test("a repository with nothing live says that, and offers only the way to open one", () => {
  const error = missingSession({
    repoRoot: "/repo",
    branch: "other",
    base: "main",
    verb: "wait",
    sessions: [session({ branch: "old", status: "ended" }), session({ repoRoot: "/elsewhere" })],
  });

  assert.equal(error.detail, "no live sessions in this repo");
  assert.equal(error.suggestions.length, 1);
  assert.match(error.suggestions[0] ?? "", /--intent/);
});

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

/**
 * No live session, and the last one here is ended: "no live session" read as
 * "open one", and agents reopened reviews the reviewer had closed.
 */
test("a repository whose latest review ended says who ended it and reopens only on request", () => {
  const sessions = [
    session({ branch: "older", status: "ended", updatedAt: "2025-01-01T00:00:00.000Z" }),
    session({
      branch: "feature-auth",
      status: "ended",
      endedBy: "reviewer",
      updatedAt: "2025-01-03T00:00:00.000Z",
    }),
  ];

  assert.throws(
    () => resolveSession(sessions, "/repo", undefined, undefined),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "session_ended");
      assert.match(error.message, /the reviewer ended the review of feature-auth against main/);
      assert.match(error.suggestions[0]!, /Only if the reviewer asks/);
      assert.match(error.suggestions[0]!, /lightspeed open feature-auth main --reopen/);
      return true;
    },
  );
});

test("a review the agent ended is said to be the agent's doing", () => {
  const sessions = [session({ status: "ended", endedBy: "agent" })];

  assert.throws(
    () => resolveSession(sessions, "/repo", undefined, undefined),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.match(error.message, /you ended the review of feature-auth against main/);
      return true;
    },
  );
});
