import { test } from "node:test";
import assert from "node:assert/strict";
import {
  helpNextRound,
  helpPublishAndWait,
  helpReopen,
  homeOutput,
  legalMoves,
  nextMoves,
  sessionSummaries,
  turnHelp,
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

test("empty state offers exactly the start command as next step", () => {
  const output = homeOutput({ repoRoot: "/repo", sessions: [] });

  const help = output.help as string[];
  assert.equal(help.length, 1);
  assert.match(help[0]!, /^Run `lightspeed start <branch> \[base\] --intent /);
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
  assert.match(help[1]!, /^Run `lightspeed start <branch> \[base\] --intent /);
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
  assert.deepEqual(output.help, [
    "Queue always. End always. Send only on your turn.",
    ...(
      homeOutput({ repoRoot: "/repo", sessions: [record({ branch: "feat/tokens" })] })
        .help as string[]
    ).slice(1),
  ]);
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
 * working`, which the poll refuses with `turn_still_yours`. `legalMoves` is the
 * one list no answer may contradict.
 */
test("one session in the repo: the help is that session's own legal moves", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [
      record({
        branch: "feat/tokens",
        turn: { holder: "agent", mode: "working", at: "2025-01-02T00:00:00.000Z", note: "mint()" },
      }),
    ],
  });

  const help = output.help as string[];
  assert.equal(help[0], "Queue always. End always. Send only on your turn.");
  assert.equal(help[1], helpPublishAndWait("feat/tokens main"));
  assert.ok(!help.some((line) => /lightspeed wait/.test(line)));
});

test("a reviewer's turn is the one turn the home view offers a wait from", () => {
  const output = homeOutput({ repoRoot: "/repo", sessions: [record({ branch: "feat/tokens" })] });

  assert.deepEqual(output.help, [
    "Queue always. End always. Send only on your turn.",
    "Run `lightspeed wait feat/tokens main` in the foreground to take the turn when the" +
      " reviewer sends — it blocks until the reviewer sends, so never background it or wrap" +
      " it in a timeout",
  ]);
});

/** Two sessions, two turns: no single set of moves is the answer. */
test("session listing help leads with the rule and covers start, wait and end", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [record({}), record({ key: "b", branch: "fix-billing" })],
  });

  const help = output.help as string[];
  assert.equal(help.length, 4);
  assert.equal(help[0]!, "Queue always. End always. Send only on your turn.");
  assert.match(help[1]!, /^Run `lightspeed start <branch> \[base\] --intent /);
  assert.match(help[2]!, /^Run `lightspeed wait <branch> \[base\]`/);
  assert.match(help[3]!, /^Run `lightspeed end <branch> \[base\]`/);
});

test("wait help warns it must block in the foreground", () => {
  const output = homeOutput({
    repoRoot: "/repo",
    sessions: [record({}), record({ key: "b", branch: "fix-billing" })],
  });

  const waitHelp = (output.help as string[])[2]!;
  assert.match(waitHelp, /foreground/);
  assert.match(waitHelp, /never background it or wrap it in a timeout/);
});

/**
 * The same four-line block was printed by `wait`, `ask`, `say`, `work` and
 * every turn refusal in that state — 146 of an `ask` answer's 187 tokens, and
 * one 17-token clause 19 times in a single transcript. After the first answer
 * of a round has spelt the moves out, the reminder is one line.
 */
test("the short form names the same moves, in the same order, on one line", () => {
  assert.equal(
    nextMoves("agent working", "feat/tokens main"),
    'Next: `lightspeed start feat/tokens main --wait --intent "<why>"`' +
      ' | `ask "<q>"` | `say "<text>"`',
  );
  assert.equal(
    nextMoves("agent reading", "feat/tokens main"),
    'Next: `lightspeed work "<plan>" feat/tokens main` | `say "<text>"` | `ask "<q>"`' +
      ' | commit then `start feat/tokens main --intent "<why>"`',
  );
  assert.equal(
    nextMoves("reviewer", "feat/tokens main"),
    "Next: `lightspeed wait feat/tokens main`",
  );
});

test("no turn offers a move in one form that the other form leaves out", () => {
  for (const turn of ["reviewer", "agent reading", "agent working", "ended"] as const) {
    const short = nextMoves(turn, "b m");
    const full = legalMoves(turn, "b m");
    assert.equal(short.split(" | ").length, full.length, turn);
  }
});

test("the full block is what a turn's first answer carries, the short line the rest", () => {
  assert.deepEqual(turnHelp("agent working", "b m", "full"), legalMoves("agent working", "b m"));
  assert.deepEqual(turnHelp("agent working", "b m", "short"), [nextMoves("agent working", "b m")]);
  // A server too old to say which is one that never heard of the short form.
  assert.deepEqual(turnHelp("agent working", "b m", undefined), legalMoves("agent working", "b m"));
});

test("the next-round line carries the --intent start refuses to run without", () => {
  assert.equal(
    helpNextRound("feat/tokens main"),
    "Address the feedback, commit, then run `lightspeed start feat/tokens main" +
      ' --intent "<why this branch exists>"` to show the updated diff —' +
      " --intent is required on every round",
  );
});

test("the publish-and-block line carries --intent too", () => {
  assert.equal(
    helpPublishAndWait("feat/tokens main"),
    "Run `lightspeed start feat/tokens main --wait" +
      ' --intent "<why this branch exists>"` to publish what you changed and block on the' +
      " next round",
  );
});

test("the reopen line names this session and the intent a new round needs", () => {
  assert.equal(
    helpReopen("feat/tokens main"),
    'Run `lightspeed start feat/tokens main --reopen --intent "<why>"`' +
      " once the reviewer asks for one",
  );
});
