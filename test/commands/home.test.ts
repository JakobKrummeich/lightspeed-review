import { test } from "node:test";
import assert from "node:assert/strict";
import { homeOutput, sessionSummaries } from "../../src/commands/home.ts";
import type { SessionRecord } from "../../src/session-store.ts";

function record(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    key: "abc123",
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

test("a stored session becomes a row carrying its undelivered feedback count", () => {
  const summaries = sessionSummaries([
    record({ status: "feedback", pending: [{ type: "message", comment: "fix it" }] }),
  ]);

  assert.deepEqual(summaries, [
    { branch: "feature-auth", base: "main", status: "feedback", pending: 1 },
  ]);
});

test("ended sessions are not listed as active work", () => {
  assert.deepEqual(sessionSummaries([record({ status: "ended" })]), []);
});

test("empty state is definitive: sessions 0 plus a message", () => {
  const output = homeOutput([]);

  assert.equal(output.sessions, 0);
  assert.equal(output.message, "no active review sessions");
});

test("empty state offers exactly the start command as next step", () => {
  const output = homeOutput([]);

  const help = output.help as string[];
  assert.equal(help.length, 1);
  assert.match(help[0]!, /^Run `lightspeed start <branch> \[base\] --intent /);
});

test("active sessions are listed as uniform rows", () => {
  const output = homeOutput([
    { branch: "feature-auth", base: "main", status: "open", pending: 0 },
    { branch: "fix-billing", base: "develop", status: "feedback", pending: 3 },
  ]);

  assert.deepEqual(output.sessions, [
    { branch: "feature-auth", base: "main", status: "open", pending: 0 },
    { branch: "fix-billing", base: "develop", status: "feedback", pending: 3 },
  ]);
  assert.equal(output.message, undefined);
});

test("session listing help covers start, poll and end", () => {
  const output = homeOutput([{ branch: "feature-auth", base: "main", status: "open", pending: 0 }]);

  const help = output.help as string[];
  assert.equal(help.length, 3);
  assert.match(help[0]!, /^Run `lightspeed start <branch> \[base\] --intent /);
  assert.match(help[1]!, /^Run `lightspeed poll <branch> \[base\]`/);
  assert.match(help[2]!, /^Run `lightspeed end <branch> \[base\]`/);
});

test("poll help warns it must block in the foreground", () => {
  const output = homeOutput([{ branch: "feature-auth", base: "main", status: "open", pending: 0 }]);

  const pollHelp = (output.help as string[])[1]!;
  assert.match(pollHelp, /foreground/);
  assert.match(pollHelp, /never background it or wrap it in a timeout/);
});
