import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile } from "../../src/diff-extract.ts";
import {
  nextSessionRecord,
  withClosedRound,
  type CreateSessionRequest,
} from "../../src/rounds/session-round.ts";
import type { SessionRecord } from "../../src/session-store.ts";

/** A patch whose blob shas are what a later round compares against. */
function diffFile(path: string, blob: string): DiffFile {
  return {
    path,
    status: "modified",
    diff: `index 0000000..${blob} 100644\n@@ -1 +1 @@\n-old\n+new`,
    insertions: 1,
    deletions: 1,
    oversized: false,
  };
}

/** A deletion, which git writes with an all-zero new-side blob. */
function deletedFile(path: string): DiffFile {
  return {
    path,
    status: "deleted",
    diff: `index 3367afd..0000000 100644\n@@ -1 +0,0 @@\n-old`,
    insertions: 0,
    deletions: 1,
    oversized: false,
  };
}

function payload(files: DiffFile[]): CreateSessionRequest {
  return {
    repoRoot: "/repo",
    branch: "feature",
    base: "main",
    groups: [{ name: "All Changes", rationale: "everything", files }],
    intents: ["why this branch exists"],
    commits: ["a commit on the branch"],
  };
}

function stamp(round: number) {
  return { key: "key", round: `rnd_${round}`, now: `2026-03-0${round}T00:00:00.000Z` };
}

/**
 * Round zero as "Send to Agent" leaves it: `approvedPaths` ticked, the round
 * still open — the state the next `start` has to make sense of.
 */
function firstRound(files: DiffFile[], approvedPaths: string[]): SessionRecord {
  const opened = nextSessionRecord(undefined, payload(files), stamp(0));
  return { ...opened, approved: approvedPaths };
}

test("declarations survive the next start: the agent's word crosses rounds", () => {
  const first = firstRound([diffFile("src/a.ts", "aaa1111")], []);
  const declared = {
    ...first,
    declarations: {
      evt_a: { note: "one transaction now", files: ["src/a.ts"], at: "2026-03-01T01:00:00.000Z" },
    },
  };

  const second = nextSessionRecord(declared, payload([diffFile("src/a.ts", "aaa2222")]), stamp(1));

  assert.deepEqual(second.declarations, declared.declarations);
});

test("a session that never declared stays without the field after a start", () => {
  const first = firstRound([diffFile("src/a.ts", "aaa1111")], []);

  const second = nextSessionRecord(first, payload([diffFile("src/a.ts", "aaa1111")]), stamp(1));

  assert.equal("declarations" in second, false);
});

test("a first round has nothing approved yet", () => {
  const record = nextSessionRecord(undefined, payload([diffFile("src/a.ts", "aaa1111")]), stamp(0));

  assert.deepEqual(record.approved, []);
  assert.deepEqual(
    record.rounds.map((round) => round.index),
    [0],
  );
});

test("a file approved in the previous round and untouched arrives approved", () => {
  const first = firstRound([diffFile("src/a.ts", "aaa1111")], ["src/a.ts"]);

  const second = nextSessionRecord(first, payload([diffFile("src/a.ts", "aaa1111")]), stamp(1));

  assert.deepEqual(second.approved, ["src/a.ts"]);
});

test("a file the agent edited after approval must be read again", () => {
  const first = firstRound([diffFile("src/a.ts", "aaa1111")], ["src/a.ts"]);

  const second = nextSessionRecord(first, payload([diffFile("src/a.ts", "aaa2222")]), stamp(1));

  assert.deepEqual(second.approved, []);
});

test("a file nobody approved is never carried", () => {
  const first = firstRound([diffFile("src/a.ts", "aaa1111")], []);

  const second = nextSessionRecord(first, payload([diffFile("src/a.ts", "aaa1111")]), stamp(1));

  assert.deepEqual(second.approved, []);
});

test("only the files still in the diff are carried", () => {
  const first = firstRound(
    [diffFile("src/a.ts", "aaa1111"), diffFile("src/b.ts", "bbb1111")],
    ["src/a.ts", "src/b.ts"],
  );

  const second = nextSessionRecord(first, payload([diffFile("src/b.ts", "bbb1111")]), stamp(1));

  assert.deepEqual(second.approved, ["src/b.ts"]);
});

test("opening a round closes the one the reviewer never ended", () => {
  const first = firstRound([diffFile("src/a.ts", "aaa1111")], ["src/a.ts"]);

  const second = nextSessionRecord(first, payload([diffFile("src/a.ts", "aaa1111")]), stamp(1));

  assert.deepEqual(
    second.rounds.map((round) => round.approvedAtEnd),
    [["src/a.ts"], []],
  );
});

test("an approved deletion is still a deletion, so it is carried", () => {
  const first = firstRound([deletedFile("src/gone.ts")], ["src/gone.ts"]);

  const second = nextSessionRecord(first, payload([deletedFile("src/gone.ts")]), stamp(1));

  assert.deepEqual(second.approved, ["src/gone.ts"]);
});

test("a round `end` already closed is not closed a second time into something else", () => {
  const ended = withClosedRound(firstRound([diffFile("src/a.ts", "aaa1111")], ["src/a.ts"]));

  const second = nextSessionRecord(ended, payload([diffFile("src/a.ts", "aaa1111")]), stamp(1));

  assert.deepEqual(second.rounds[0], ended.rounds[0]);
  assert.deepEqual(second.approved, ["src/a.ts"]);
});

test("the conversation survives a re-group, the grouping does not", () => {
  const first = firstRound([diffFile("src/a.ts", "aaa1111")], ["src/a.ts"]);
  const talking: SessionRecord = {
    ...first,
    conversation: [{ at: "2026-03-01T00:00:00.000Z", role: "reviewer", prompts: [] }],
  };

  const second = nextSessionRecord(talking, payload([diffFile("src/b.ts", "bbb1111")]), stamp(1));

  assert.equal(second.conversation.length, 1);
  assert.deepEqual(second.groups[0]?.files[0]?.path, "src/b.ts");
  assert.deepEqual(second.approved, []);
});

test("a re-grouped review that stays ended keeps the record of who ended it", () => {
  const closed: SessionRecord = {
    ...firstRound([diffFile("src/a.ts", "aaa1111")], []),
    status: "ended",
    endedBy: "reviewer",
  };

  const second = nextSessionRecord(closed, payload([diffFile("src/a.ts", "aaa1111")]), stamp(1));

  assert.equal(second.status, "ended");
  assert.equal(second.endedBy, "reviewer");
});

test("a reopened review has not ended, so it carries no closer", () => {
  const closed: SessionRecord = {
    ...firstRound([diffFile("src/a.ts", "aaa1111")], []),
    status: "ended",
    endedBy: "agent",
  };

  const second = nextSessionRecord(
    closed,
    { ...payload([diffFile("src/a.ts", "aaa1111")]), reopen: true },
    stamp(1),
  );

  assert.equal(second.status, "open");
  assert.equal("endedBy" in second, false);
});
