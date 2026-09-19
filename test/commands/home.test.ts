import { test } from "node:test";
import assert from "node:assert/strict";
import {
  helpNextRound,
  helpPublishAndWait,
  helpReopen,
  homeOutput,
  sessionSummaries,
  type SessionSummary,
} from "../../src/commands/home.ts";
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

  // Rounds are counted from one on screen. `status` is not a column: `turn`
  // says whose move it is and `pending` how much is queued, while `feedback`
  // went on being printed for rounds after that feedback was read.
  assert.deepEqual(summaries, [
    {
      branch: "feature-auth",
      base: "main",
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

/** B3: every `wait`/`ask` answer closed with a `start` line that had no
 * `--intent`, which the CLI refuses with `intent_missing` and exit 2 — one
 * wasted turn per round, spent on a command we printed ourselves. */
test("the next-round line carries the --intent start refuses to run without", () => {
  assert.equal(
    helpNextRound("feat/tokens main"),
    "Address the feedback, commit, then run `lightspeed start feat/tokens main" +
      ' --intent "<why this branch exists>"` to show the updated diff —' +
      " --intent is required on every round",
  );
});

/** The same refusal from the other move that publishes a round: `start --wait`
 * without `--intent` exits 2 before it ever reaches git. */
test("the publish-and-block line carries --intent too", () => {
  assert.equal(
    helpPublishAndWait("feat/tokens main"),
    "Run `lightspeed start feat/tokens main --wait" +
      ' --intent "<why this branch exists>"` to publish what you changed and block on the' +
      " next round",
  );
});

/** S10: the reopen line named `<branch> [base]` while the branch and base were
 * on the command line, and left out the `--intent` the reopened round needs. */
test("the reopen line names this session and the intent a new round needs", () => {
  assert.equal(
    helpReopen("feat/tokens main"),
    'Run `lightspeed start feat/tokens main --reopen --intent "<why>"`' +
      " once the reviewer asks for one",
  );
});

test("wait help warns it must block in the foreground", () => {
  const output = homeOutput([row()]);

  const waitHelp = (output.help as string[])[2]!;
  assert.match(waitHelp, /foreground/);
  assert.match(waitHelp, /never background it or wrap it in a timeout/);
});
