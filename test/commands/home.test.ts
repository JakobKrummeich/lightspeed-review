import { test } from "node:test";
import assert from "node:assert/strict";
import { homeOutput, sessionSummaries, type SessionSummary } from "../../src/commands/home.ts";
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
    turn: { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

test("a stored session becomes a row carrying its turn, round and queue", () => {
  const summaries = sessionSummaries([
    record({
      status: "feedback",
      pending: [{ type: "message", comment: "fix it" }],
      rounds: [{ index: 1, at: "2025-01-02T00:00:00.000Z", files: [], approvedAtEnd: [] }],
      turn: { holder: "agent", mode: "working", at: "2025-01-02T00:01:00.000Z", note: "fixing it" },
    }),
  ]);

  // Rounds are counted from one on screen, and the note the banner shows is
  // the reviewer's business, not a row's.
  assert.deepEqual(summaries, [
    {
      branch: "feature-auth",
      base: "main",
      status: "feedback",
      turn: "agent working",
      round: 2,
      pending: 1,
    },
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

const row = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  branch: "feature-auth",
  base: "main",
  status: "open",
  turn: "reviewer",
  round: 1,
  pending: 0,
  ...over,
});

test("active sessions are listed as uniform rows", () => {
  const rows = [
    row(),
    row({
      branch: "fix-billing",
      base: "develop",
      status: "feedback",
      turn: "agent working",
      round: 2,
      pending: 3,
    }),
  ];

  const output = homeOutput(rows);

  // Whose move it is, on the one view an agent opens before it knows anything:
  // "may I send?" and "am I owed a turn?" answered without a second command.
  assert.deepEqual(output.sessions, rows);
  assert.equal(output.message, undefined);
});

test("session listing help leads with the rule and covers start, wait and end", () => {
  const output = homeOutput([row()]);

  const help = output.help as string[];
  assert.equal(help.length, 4);
  assert.equal(help[0]!, "Queue always. End always. Send only on your turn.");
  assert.match(help[1]!, /^Run `lightspeed start <branch> \[base\] --intent /);
  assert.match(help[2]!, /^Run `lightspeed wait <branch> \[base\]`/);
  assert.match(help[3]!, /^Run `lightspeed end <branch> \[base\]`/);
});

test("wait help warns it must block in the foreground", () => {
  const output = homeOutput([row()]);

  const waitHelp = (output.help as string[])[2]!;
  assert.match(waitHelp, /foreground/);
  assert.match(waitHelp, /never background it or wrap it in a timeout/);
});
