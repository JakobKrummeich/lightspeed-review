import { test } from "node:test";
import assert from "node:assert/strict";
import { homeOutput, sessionSummaries, type SessionSummary } from "../../src/commands/home.ts";
import { HELP_END, HELP_OPEN, TURN_RULES, nextRule } from "../../src/turn-help.ts";
import type { SessionRecord } from "../../src/session-types.ts";

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
    rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z", files: [], approvedAtEnd: [] }],
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
      note: "fixing it",
    },
  ]);
});

/** The same order every other block prints them in: the round, then whose turn it is. */
test("a row names the round before the turn", () => {
  const [row] = sessionSummaries([record({})]);

  assert.deepEqual(Object.keys(row!), ["branch", "base", "round", "turn", "pending"]);
});

/**
 * The plan an agent declared is the one thing on the record only it knows, and
 * an agent resumed after compaction reads this view to find out where it was.
 * `agent working` without the plan is the state and not the work.
 */
test("the plan a working agent declared is a column, so a resumed agent can read it", () => {
  const summaries = sessionSummaries([
    record({
      turn: {
        holder: "agent",
        mode: "working",
        at: "2025-01-02T00:01:00.000Z",
        note: "Switching mint() to a keyed hash and renaming the parameter",
      },
    }),
    record({ key: "def456", branch: "other" }),
  ]);

  assert.equal(summaries[0]?.note, "Switching mint() to a keyed hash and renaming the parameter");
  // One shape for every row, or TOON stops drawing a table at all.
  assert.equal(summaries[1]?.note, "");
});

/** Nothing declared anywhere: a column of empty strings is noise on every row. */
test("no session has a plan, so no session has a note column", () => {
  const summaries = sessionSummaries([record({}), record({ key: "def456" })]);

  assert.ok(!("note" in summaries[0]!));
});

test("ended sessions are not listed as active work", () => {
  assert.deepEqual(sessionSummaries([record({ status: "ended" })]), []);
});

test("empty state is definitive: sessions 0 plus a message", () => {
  const output = homeOutput({ repoRoot: "/repo", sessions: [] });

  assert.equal(output.repo, "/repo");
  assert.equal(output.sessions, 0);
  assert.equal(output.message, "no active review sessions");
});

test("empty state offers exactly the open command as next step", () => {
  const output = homeOutput({ repoRoot: "/repo", sessions: [] });

  const help = output.help as string[];
  assert.equal(help.length, 1);
  assert.match(help[0]!, /^Run `lightspeed open <branch> \[base\] --intent /);
});

/**
 * Regression: a bare catch swallowed `config_missing` and printed `sessions: 0`
 * with `start` as the next step — both false.
 */
test("a repository with no config says so, instead of reporting no sessions", () => {
  const output = homeOutput({
    repoRoot: "/tmp/noconf",
    config: "missing",
    sessions: [record({ repoRoot: "/elsewhere" }), record({ key: "d", repoRoot: "/far" })],
  });

  assert.equal(output.repo, "/tmp/noconf");
  assert.equal(output.config, "missing");
  assert.equal(output.sessions, 0);
  assert.equal(
    output.message,
    "no config in this repo, so no review can run here; 2 sessions live in other repos",
  );
  const help = output.help as string[];
  assert.equal(help.length, 2);
  assert.match(help[0]!, /^Run `lightspeed init --config` to write \.lightspeed\.conf\.json here/);
  assert.match(help[0]!, /anthropic\/claude-sonnet-4-5/);
  assert.match(help[1]!, /^Run `lightspeed open <branch> \[base\] --intent /);
});

test("a config that is there but unreadable is named as that, not as missing", () => {
  const output = homeOutput({ repoRoot: "/tmp/broken", config: "invalid", sessions: [] });

  assert.equal(output.config, "invalid");
  assert.match(output.message as string, /^the config in this repo cannot be read/);
});

test("run outside a repository, the view says that rather than naming one", () => {
  const output = homeOutput({ sessions: [record({ repoRoot: "/elsewhere" })] });

  assert.equal(output.repo, "none");
  assert.equal(output.sessions, 0);
  assert.match(output.message as string, /not inside a git repository/);
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
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [
      record({}),
      record({
        key: "def456",
        branch: "fix-billing",
        base: "develop",
        pending: [
          { type: "message", comment: "a" },
          { type: "message", comment: "b" },
          { type: "message", comment: "c" },
        ],
        rounds: [{ index: 1, at: "2025-01-02T00:00:00.000Z", files: [], approvedAtEnd: [] }],
        turn: { holder: "agent", mode: "working", at: "2025-01-02T00:00:00.000Z" },
      }),
    ],
  });

  // Whose move it is, on the one view an agent opens before it knows anything:
  // "may I send?" and "am I owed a turn?" answered without a second command.
  assert.deepEqual(output.sessions, [
    row(),
    row({ branch: "fix-billing", base: "develop", turn: "agent working", round: 2, pending: 3 }),
  ]);
  assert.equal(output.message, undefined);
});

/**
 * The store is one directory for the whole machine: unscoped, the view listed
 * rows from repositories that no longer exist on the machine at all.
 */
test("sessions are scoped to the repository the command ran in", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [
      record({}),
      record({ key: "b", repoRoot: "/other" }),
      record({ key: "c", repoRoot: "/other" }),
      record({ key: "d", repoRoot: "/third" }),
    ],
  });

  assert.deepEqual(output.sessions, [row()]);
  assert.equal(output.elsewhere, "3 sessions in 2 other repos — `lightspeed --all` lists them");
});

test("one session elsewhere is one session in one other repo", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [record({}), record({ key: "b", repoRoot: "/other" })],
  });

  assert.equal(output.elsewhere, "1 session in 1 other repo — `lightspeed --all` lists them");
});

/** Ended reviews are history everywhere, not just in the table: counted, they
 * make one live session look like several and take its own moves off the help. */
test("an ended review is counted nowhere: not in the rows, the tally or the help", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [
      record({ branch: "feat/tokens" }),
      record({ key: "b", branch: "done", status: "ended" }),
      record({ key: "c", repoRoot: "/other", status: "ended" }),
    ],
  });

  assert.deepEqual(output.sessions, [row({ branch: "feat/tokens" })]);
  assert.ok(!("elsewhere" in output));
  // One live session, so the answer is its own rule and not the several-session help.
  assert.deepEqual(output.next, nextRule("reviewer", "feat/tokens main"));
});

test("a blocked repo counts only the live sessions it cannot reach", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    config: "missing",
    sessions: [
      record({ key: "b", repoRoot: "/other" }),
      record({ key: "c", repoRoot: "/other", status: "ended" }),
    ],
  });

  assert.match(output.message as string, /1 session lives in another repo$/);
});

test("nothing elsewhere, nothing said about elsewhere", () => {
  const output = homeOutput({ repoRoot: "/repo", sessions: [record({})] });

  assert.ok(!("elsewhere" in output));
});

test("--all lists every repository's sessions, each under the repo it belongs to", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    all: true,
    sessions: [record({}), record({ key: "b", repoRoot: "/other", branch: "fix-billing" })],
  });

  assert.deepEqual(output.sessions, [
    { repo: "/repo", ...row() },
    { repo: "/other", ...row({ branch: "fix-billing" }) },
  ]);
  assert.ok(!("elsewhere" in output));
});

/**
 * Regression: the static help offered `wait` to a session showing `agent
 * working`, which the poll refuses with `turn_still_yours`. With one session,
 * home ends in the same `next:` rule every command ends in.
 */
test("one session in the repo: the answer is that session's own next rule", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [
      record({
        branch: "feat/tokens",
        turn: { holder: "agent", mode: "working", at: "2025-01-02T00:00:00.000Z", note: "mint()" },
      }),
    ],
  });

  assert.deepEqual(output.next, nextRule("agent working", "feat/tokens main"));
  assert.equal("help" in output, false);
});

test("a reviewer's turn is the one turn home offers to listen from", () => {
  const output = homeOutput({ repoRoot: "/repo", sessions: [record({ branch: "feat/tokens" })] });

  assert.deepEqual(output.next, nextRule("reviewer", "feat/tokens main"));
  assert.match((output.next as { listen: string }).listen, /lightspeed open feat\/tokens main`/);
  assert.match((output.next as { listen: string }).listen, /foreground/);
});

/** Telling an agent to start a wait that is already running supersedes its own command. */
test("a reviewer's turn someone is listening on says to leave the wait running, not to open", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [record({ branch: "feat/tokens" })],
    listening: true,
  });

  const next = output.next as Record<string, string>;
  assert.deepEqual(Object.keys(next), ["listening"]);
  assert.match(next.listening!, /already waiting/);
  assert.match(next.listening!, /leave it running/);
});

/**
 * The waiter home sees may be a leftover from a killed session: an agent that
 * cannot read its output must still have a way to take the batch.
 */
test("a wait the agent cannot see is taken over by re-attaching, which ends the old one", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [record({ branch: "feat/tokens" })],
    listening: true,
  });

  const listening = (output.next as Record<string, string>).listening!;
  assert.match(
    listening,
    /cannot see that command's output, run `lightspeed open feat\/tokens main` now/,
  );
  assert.match(listening, /newest wait takes over and the old one exits/);
});

/** Sent, and nobody there to receive it: the one command that takes the batch. */
test("a Send nobody received says how many items are waiting and what receives them", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [
      record({
        branch: "feat/tokens",
        pending: [
          { type: "message", id: "t1", comment: "why?" },
          { type: "message", id: "t2", comment: "and this?" },
        ],
      }),
    ],
    listening: false,
  });

  const next = output.next as Record<string, string>;
  assert.match(
    next.receive!,
    /the reviewer sent 2 items — `lightspeed open feat\/tokens main` receives them/,
  );
});

/** Compaction loses the batch; `open` hands the same one back. */
test("a digesting agent is told how to get the batch it lost, then the rule", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [
      record({
        turn: { holder: "agent", mode: "digesting", at: "2025-01-02T00:00:00.000Z" },
        conversation: [
          {
            role: "reviewer",
            at: "2025-01-02T00:00:00.000Z",
            prompts: [{ type: "message", id: "t3", comment: "why?" }],
          },
        ],
        batch: {
          id: "dlv_1",
          at: "2025-01-02T00:00:00.000Z",
          prompts: [{ type: "message", id: "t3", comment: "why?" }],
          acked: true,
        },
      }),
    ],
  });

  const next = output.next as Record<string, string>;
  assert.equal(Object.keys(next)[0], "reread");
  assert.match(next.reread!, /lightspeed open feature-auth main/);
  assert.match(next.reread!, /the batch you are digesting/);
  // Digesting, no Send is coming: `open` hands the held batch straight back.
  assert.doesNotMatch(next.reread!, /next Send|waits for the reviewer/);
  assert.match(next.talk!, /--to t3 '<answer>'/);
});

/** A thread the reviewer resolved is closed: home never suggests answering in it. */
test("a digesting agent is never pointed at a thread the reviewer resolved", () => {
  const said = { type: "message" as const, id: "t3", comment: "why?" };
  const done = { type: "message" as const, id: "t4", comment: "fixed, thanks" };
  const resolve = { type: "resolve" as const, thread: "t4", resolved: true };
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [
      record({
        turn: { holder: "agent", mode: "digesting", at: "2025-01-02T00:00:00.000Z" },
        conversation: [
          { role: "reviewer", at: "2025-01-02T00:00:00.000Z", prompts: [said, done, resolve] },
        ],
        batch: {
          id: "dlv_1",
          at: "2025-01-02T00:00:00.000Z",
          prompts: [said, done, resolve],
          acked: true,
        },
      }),
    ],
  });

  const next = output.next as Record<string, string>;
  assert.match(next.talk!, /--to t3 '<answer>'/);
  assert.doesNotMatch(JSON.stringify(next), /--to t4/);
  assert.match(next.resolved!, /t4/);
});

/** Two sessions, two turns: no single rule is the answer. */
test("several sessions: the help is the turn rules, then open and end", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [record({}), record({ key: "b", branch: "fix-billing" })],
  });

  assert.deepEqual(output.help, [...TURN_RULES, HELP_OPEN, HELP_END]);
  assert.equal("next" in output, false);
});
