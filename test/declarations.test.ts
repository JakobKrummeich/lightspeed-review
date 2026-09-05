import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDeclarations,
  validateDeclarations,
  withDeclarations,
  type ReadRoundDiff,
} from "../src/declarations.ts";
import type { DiffNames } from "../src/git-file.ts";
import type { SessionRecord, SessionRound } from "../src/session-store.ts";

test("a well-formed declaration parses, files defaulting to none", () => {
  assert.deepEqual(parseDeclarations([{ id: "evt_a", note: "fixed" }]), [
    { id: "evt_a", note: "fixed", files: [] },
  ]);
  assert.deepEqual(parseDeclarations([{ id: "evt_a", files: ["a.ts", "b.ts"] }]), [
    { id: "evt_a", files: ["a.ts", "b.ts"] },
  ]);
});

test("a file said twice is said once: redeclaring must compare equal", () => {
  assert.deepEqual(parseDeclarations([{ id: "evt_a", files: ["a.ts", "a.ts"] }]), [
    { id: "evt_a", files: ["a.ts"] },
  ]);
});

test("malformed declarations are rejected as a whole, not partially read", () => {
  assert.equal(parseDeclarations("evt_a"), undefined);
  assert.equal(parseDeclarations([{ note: "no id" }]), undefined);
  assert.equal(parseDeclarations([{ id: "" }]), undefined);
  assert.equal(parseDeclarations([{ id: "evt_a", note: 7 }]), undefined);
  assert.equal(parseDeclarations([{ id: "evt_a", files: "a.ts" }]), undefined);
  assert.equal(parseDeclarations([{ id: "evt_a", files: [""] }]), undefined);
  assert.equal(parseDeclarations([{ id: "evt_a" }, null]), undefined);
});

/** A session with one identified comment, made in a round with `headCommit`. */
function reviewed(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const rounds: SessionRound[] = [
    {
      index: 0,
      at: "2025-01-01T00:00:00.000Z",
      headCommit: "aaaaaaa",
      files: [],
      approvedAtEnd: [],
    },
    {
      index: 1,
      at: "2025-01-02T00:00:00.000Z",
      headCommit: "bbbbbbb",
      files: [],
      approvedAtEnd: [],
    },
  ];
  return {
    key: "k",
    repoRoot: "/repo",
    branch: "work",
    base: "main",
    status: "feedback",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
    groups: [],
    conversation: [
      {
        role: "reviewer",
        at: "2025-01-01T01:00:00.000Z",
        roundIndex: 0,
        prompts: [
          {
            type: "annotation",
            id: "evt_a",
            file: "src/api/users.ts",
            group: "API",
            selected_text: "+x",
            comment: "wrap it",
          },
        ],
      },
    ],
    pending: [],
    approved: [],
    rounds,
    ...overrides,
  };
}

const changed =
  (paths: string[]): ReadRoundDiff =>
  () => ({ state: "files", files: paths });

test("a declaration for a known comment naming changed files has no problems", () => {
  const problems = validateDeclarations(
    reviewed(),
    [{ id: "evt_a", note: "done", files: ["src/api/users.ts"] }],
    changed(["src/api/users.ts"]),
  );

  assert.deepEqual(problems, []);
});

test("an unknown id is rejected by name", () => {
  const problems = validateDeclarations(
    reviewed(),
    [{ id: "evt_ghost", note: "done", files: [] }],
    changed([]),
  );

  assert.equal(problems.length, 1);
  assert.equal(problems[0]?.id, "evt_ghost");
  assert.match(problems[0]?.reason ?? "", /no reviewer comment has this id/);
});

test("a comment from before ids existed cannot be declared against", () => {
  const session = reviewed();
  const [entry] = session.conversation;
  const prompt = entry!.prompts[0]!;
  if (prompt.type === "annotation") delete prompt.id;

  const problems = validateDeclarations(
    session,
    [{ id: "evt_a", note: "done", files: [] }],
    changed([]),
  );

  assert.match(problems[0]?.reason ?? "", /no reviewer comment has this id/);
});

test("a declaration that says nothing is named as such", () => {
  const problems = validateDeclarations(reviewed(), [{ id: "evt_a", files: [] }], changed([]));

  assert.match(problems[0]?.reason ?? "", /declares nothing/);
});

test("one comment declared twice in one request is ambiguous, so it is rejected", () => {
  const problems = validateDeclarations(
    reviewed(),
    [
      { id: "evt_a", note: "one", files: [] },
      { id: "evt_a", note: "two", files: [] },
    ],
    changed([]),
  );

  assert.deepEqual(problems, [{ id: "evt_a", reason: "declared twice in one reply" }]);
});

test("a declared file the between-round diff never touched is rejected, whole", () => {
  const problems = validateDeclarations(
    reviewed(),
    [{ id: "evt_a", note: "done", files: ["src/api/users.ts", "src/untouched.ts"] }],
    changed(["src/api/users.ts"]),
  );

  assert.equal(problems.length, 1);
  assert.match(problems[0]?.reason ?? "", /src\/untouched\.ts is not in the between-round diff/);
  assert.match(problems[0]?.reason ?? "", /aaaaaaa\.\.bbbbbbb/);
});

test("a path that is not a literal changed file is refused, not stored as one", () => {
  // Absolute paths, escapes, globs, pathspec magic and directories all fail
  // the same way: they are not members of git's own file list for the diff.
  const garbage = ["/etc/passwd", "../outside.ts", "src/*.ts", ":(top)users.ts", ":/", "src"];
  const problems = validateDeclarations(
    reviewed(),
    [{ id: "evt_a", files: garbage }],
    changed(["src/api/users.ts"]),
  );

  assert.equal(problems.length, garbage.length);
  for (const problem of problems) {
    assert.match(problem.reason, /is not in the between-round diff/);
  }
});

test("unknowable history accepts the declaration instead of guessing it wrong", () => {
  const answer: DiffNames = { state: "unknowable" };
  const problems = validateDeclarations(
    reviewed(),
    [{ id: "evt_a", files: ["src/anything.ts"] }],
    () => answer,
  );

  assert.deepEqual(problems, []);
});

test("declaring files before the next round says so and points at `start`", () => {
  const session = reviewed();
  session.conversation[0]!.roundIndex = 1; // comment made in the current round

  const problems = validateDeclarations(
    session,
    [{ id: "evt_a", files: ["src/api/users.ts"] }],
    () => {
      throw new Error("git must not be asked when both ends are one commit");
    },
  );

  assert.equal(problems.length, 1);
  assert.match(problems[0]?.reason ?? "", /no round has been started since this comment/);
  assert.match(problems[0]?.reason ?? "", /lightspeed start/);
  assert.match(problems[0]?.reason ?? "", /--note only/);
});

test("rounds without recorded commits skip the file check rather than fail it", () => {
  const bare = reviewed();
  const rounds = bare.rounds.map((round) => {
    const copy = { ...round };
    delete copy.headCommit;
    return copy;
  });
  const problems = validateDeclarations(
    { ...bare, rounds },
    [{ id: "evt_a", files: ["src/anything.ts"] }],
    () => {
      throw new Error("git must not be asked without commits to compare");
    },
  );

  assert.deepEqual(problems, []);
});

test("withDeclarations stores by comment id and redeclaring replaces wholesale", () => {
  const first = withDeclarations(
    reviewed(),
    [{ id: "evt_a", note: "one", files: ["a.ts"] }],
    "2025-01-02T01:00:00.000Z",
  );
  const second = withDeclarations(
    first,
    [{ id: "evt_a", files: ["b.ts"] }],
    "2025-01-02T02:00:00.000Z",
  );

  assert.deepEqual(first.declarations, {
    evt_a: { note: "one", files: ["a.ts"], at: "2025-01-02T01:00:00.000Z" },
  });
  // The old note does not linger under the new files: absence must stay absence.
  assert.deepEqual(second.declarations, {
    evt_a: { files: ["b.ts"], at: "2025-01-02T02:00:00.000Z" },
  });
});

test("declaring nothing leaves the session untouched, older declarations intact", () => {
  const before = withDeclarations(
    reviewed(),
    [{ id: "evt_a", note: "one", files: [] }],
    "2025-01-02T01:00:00.000Z",
  );

  assert.equal(withDeclarations(before, [], "2025-01-02T02:00:00.000Z"), before);
});
