import { test } from "node:test";
import assert from "node:assert/strict";
import { outcomeRecords, verdictFor, type ReadFileDiff } from "../../src/ledger/outcomes.ts";
import {
  buildAnnotationRecord,
  createIdSource,
  type AnnotationRecord,
  type RepoRef,
  type Verdict,
} from "../../src/ledger/records.ts";
import type { RoundFile, SessionRecord, SessionRound } from "../../src/session-store.ts";

const REPO: RepoRef = { root: "/repo", name: "repo", remote: null };
const NOW = "2026-02-14T10:00:00.000Z";

/** A round as `start` writes it: its ledger id, its head commit, its files. */
function round(index: number, files: RoundFile[], approvedAtEnd: string[] = []): SessionRound {
  return {
    index,
    round: `rnd_${index}`,
    at: `2026-02-1${index}T00:00:00.000Z`,
    baseCommit: `base${index}${"0".repeat(6)}`,
    headCommit: `head${index}${"0".repeat(6)}`,
    files,
    approvedAtEnd,
  };
}

function file(path: string, blob: string | null, previousPath?: string): RoundFile {
  return {
    path,
    status: previousPath === undefined ? "modified" : "renamed",
    blob,
    ...(previousPath === undefined ? {} : { previousPath }),
  };
}

function session(rounds: SessionRound[]): SessionRecord {
  return {
    key: "repo-feat-main",
    repoRoot: "/repo",
    branch: "feat",
    base: "main",
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
    groups: [],
    conversation: [],
    pending: [],
    approved: [],
    rounds,
  };
}

function annotation(id: string, roundId: string, path: string): AnnotationRecord {
  return buildAnnotationRecord({
    id,
    at: "2026-02-13T12:00:00.000Z",
    round: roundId,
    repo: REPO,
    branch: "feat",
    base: "main",
    base_commit: null,
    head_commit: null,
    file: path,
    previous_path: null,
    file_status: "modified",
    group: "Handlers",
    blob_new: null,
    blob_old: null,
    selected_text: "+new",
    comment: "return a ReviewError",
  });
}

/** Git that always answers, remembering what it was asked for. */
function fakeDiff(patch = "@@ -1 +1 @@\n-old\n+new"): ReadFileDiff & { calls: string[][] } {
  const calls: string[][] = [];
  const read = (from: string, to: string, paths: string[]) => {
    calls.push([from, to, ...paths]);
    return patch;
  };
  return Object.assign(read, { calls });
}

/** Git that cannot reach a commit — a rebase or force-push happened. */
const unreachable: ReadFileDiff = () => undefined;

function judge(
  rounds: SessionRound[],
  annotations: AnnotationRecord[],
  diffFile: ReadFileDiff = fakeDiff(),
) {
  return outcomeRecords({
    repo: REPO,
    now: NOW,
    nextId: createIdSource(),
    nextRound: rounds.at(-1)?.round ?? "rnd_next",
    session: session(rounds),
    annotations,
    diffFile,
  });
}

test("a file the agent changed between the rounds is addressed, with its response patch", () => {
  const diff = fakeDiff();
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])],
    [annotation("evt_1", "rnd_0", "src/a.ts")],
    diff,
  );

  assert.equal(outcomes.length, 1);
  assert.partialDeepStrictEqual(outcomes[0], {
    kind: "outcome",
    about: "evt_1",
    next_round: "rnd_1",
    from_commit: "head0000000",
    to_commit: "head1000000",
    file_touched: true,
    response_patch: "@@ -1 +1 @@\n-old\n+new",
    re_annotated: false,
    approved: false,
    verdict: "addressed",
  });
  assert.deepEqual(diff.calls, [["head0000000", "head1000000", "src/a.ts"]]);
});

test("a file nobody touched and nobody approved is ignored", () => {
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa1111")])],
    [annotation("evt_1", "rnd_0", "src/a.ts")],
    fakeDiff(""),
  );

  assert.partialDeepStrictEqual(outcomes[0], {
    file_touched: false,
    approved: false,
    verdict: "ignored",
  });
  assert.equal(outcomes[0]?.response_patch, undefined);
});

test("an untouched file the reviewer signed off is addressed", () => {
  const outcomes = judge(
    [
      round(0, [file("src/a.ts", "aaa1111")], ["src/a.ts"]),
      round(1, [file("src/a.ts", "aaa1111")]),
    ],
    [annotation("evt_1", "rnd_0", "src/a.ts")],
    fakeDiff(""),
  );

  assert.partialDeepStrictEqual(outcomes[0], {
    file_touched: false,
    approved: true,
    verdict: "addressed",
  });
});

test("a file annotated again in a later round is repeated", () => {
  const outcomes = judge(
    [
      round(0, [file("src/a.ts", "aaa1111")]),
      round(1, [file("src/a.ts", "aaa2222")]),
      round(2, [file("src/a.ts", "aaa3333")]),
    ],
    [annotation("evt_1", "rnd_0", "src/a.ts"), annotation("evt_2", "rnd_1", "src/a.ts")],
    fakeDiff(),
  );

  assert.deepEqual(
    outcomes.map((outcome) => [outcome.about, outcome.re_annotated, outcome.verdict]),
    [
      ["evt_1", true, "repeated"],
      ["evt_2", false, "addressed"],
    ],
  );
});

test("a second annotation on another file does not make an outcome repeated", () => {
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])],
    [annotation("evt_1", "rnd_0", "src/a.ts"), annotation("evt_2", "rnd_0", "src/b.ts")],
    fakeDiff(),
  );

  assert.deepEqual(
    outcomes.map((outcome) => outcome.re_annotated),
    [false, false],
  );
});

test("two annotations on one file ask git for its diff once", () => {
  const diff = fakeDiff();
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])],
    [annotation("evt_1", "rnd_0", "src/a.ts"), annotation("evt_2", "rnd_0", "src/a.ts")],
    diff,
  );

  assert.equal(outcomes.length, 2);
  assert.deepEqual(diff.calls, [["head0000000", "head1000000", "src/a.ts"]]);
});

test("a commit git cannot reach yields unknown, never a guess", () => {
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])],
    [annotation("evt_1", "rnd_0", "src/a.ts")],
    unreachable,
  );

  assert.partialDeepStrictEqual(outcomes[0], { file_touched: true, verdict: "unknown" });
  assert.equal(outcomes[0]?.response_patch, undefined);
});

test("a round written before commits were recorded yields unknown", () => {
  const [first, second] = [
    round(0, [file("src/a.ts", "aaa1111")]),
    round(1, [file("src/a.ts", "b")]),
  ];
  const rounds = [{ ...first, headCommit: undefined }, second];

  const outcomes = judge(rounds as SessionRound[], [annotation("evt_1", "rnd_0", "src/a.ts")]);

  assert.partialDeepStrictEqual(outcomes[0], { from_commit: null, verdict: "unknown" });
});

test("a rename is followed forward and git is asked for both names", () => {
  const diff = fakeDiff();
  const outcomes = judge(
    [
      round(0, [file("src/old.ts", "aaa1111")]),
      round(1, [file("src/new.ts", "aaa2222", "src/old.ts")]),
    ],
    [annotation("evt_1", "rnd_0", "src/old.ts")],
    diff,
  );

  assert.partialDeepStrictEqual(outcomes[0], { file_touched: true, verdict: "addressed" });
  assert.deepEqual(diff.calls, [["head0000000", "head1000000", "src/old.ts", "src/new.ts"]]);
});

test("a file deleted since the annotation counts as touched", () => {
  const deleted: RoundFile = { path: "src/a.ts", status: "deleted", blob: null };
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [deleted])],
    [annotation("evt_1", "rnd_0", "src/a.ts")],
  );

  assert.partialDeepStrictEqual(outcomes[0], { file_touched: true, verdict: "addressed" });
});

test("annotations of the round now opening are not judged yet", () => {
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])],
    [annotation("evt_1", "rnd_1", "src/a.ts")],
  );

  assert.deepEqual(outcomes, []);
});

test("an annotation from a round this session no longer remembers is skipped", () => {
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])],
    [annotation("evt_1", "rnd_gone", "src/a.ts")],
  );

  assert.deepEqual(outcomes, []);
});

test("a session whose first round is only now opening judges nothing", () => {
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")])],
    [annotation("evt_1", "rnd_0", "src/a.ts")],
  );

  assert.deepEqual(outcomes, []);
});

test("an oversized response patch is capped and marked", () => {
  const huge = `${"@@ line\n".repeat(3000)}`;
  const outcomes = judge(
    [round(0, [file("src/a.ts", "aaa1111")]), round(1, [file("src/a.ts", "aaa2222")])],
    [annotation("evt_1", "rnd_0", "src/a.ts")],
    fakeDiff(huge),
  );

  assert.deepEqual(outcomes[0]?.truncated, ["response_patch"]);
  assert.equal((outcomes[0]?.response_patch ?? "").split("\n").length, 2000);
});

/** Every combination of the facts, so no pair of verdict tests can overlap. */
test("verdictFor labels every combination of facts exactly once", () => {
  const expected: [boolean, boolean, boolean, boolean, Verdict][] = [
    [false, false, false, false, "unknown"],
    [false, true, true, true, "unknown"],
    [true, false, false, false, "ignored"],
    [true, true, false, false, "addressed"],
    [true, false, false, true, "addressed"],
    [true, true, false, true, "addressed"],
    [true, false, true, false, "repeated"],
    [true, true, true, false, "repeated"],
    [true, false, true, true, "repeated"],
    [true, true, true, true, "repeated"],
  ];

  for (const [comparable, fileTouched, reAnnotated, approved, verdict] of expected) {
    assert.equal(verdictFor({ comparable, fileTouched, reAnnotated, approved }), verdict, verdict);
  }
});
