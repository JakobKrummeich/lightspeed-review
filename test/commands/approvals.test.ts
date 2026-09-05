import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PATH_LIMIT,
  parseApprovalsArgs,
  runApprovals,
} from "../../src/commands/approvals.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { SessionStore, type SessionRecord } from "../../src/session-store.ts";
import type { DiffGroup } from "../../src/diff-extract.ts";
import type { GroupTier } from "../../src/group-tier.ts";

const REPO = "/repo";
const BRANCH = "feature-auth";
const BASE = "main";

function group(name: string, tier: GroupTier, ...paths: string[]): DiffGroup {
  return {
    name,
    rationale: "why",
    tier,
    files: paths.map((path) => ({
      path,
      status: "modified" as const,
      diff: "",
      insertions: 1,
      deletions: 0,
      oversized: false,
    })),
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: sessionKey(REPO, BRANCH, BASE),
    repoRoot: REPO,
    branch: BRANCH,
    base: BASE,
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

/** The store the command reads: on disk, with no server anywhere. */
function stateWith(record: SessionRecord): string {
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-approvals-"));
  new SessionStore(stateDir).save(record);
  return stateDir;
}

const run = (stateDir: string, full = false) =>
  runApprovals({ repoRoot: REPO, branch: BRANCH, base: BASE, stateDir, full });

/** A review of `count` files nobody ticked: the shape a cap has to survive. */
function bigState(count: number): string {
  const paths = Array.from({ length: count }, (_, index) => `src/file-${index}.ts`);
  return stateWith(session({ status: "ended", groups: [group("Auth", "study", ...paths)] }));
}

const asRecord = (value: unknown) => value as Record<string, unknown>;

test("names every file behind the counts, and which of them a lane swept", () => {
  const stateDir = stateWith(
    session({
      status: "ended",
      groups: [
        group("Auth", "study", "src/auth.ts", "src/errors.ts"),
        group("Docs", "sweep", "docs/api.md", "README.md"),
      ],
      approved: ["src/auth.ts", "docs/api.md", "README.md"],
    }),
  );

  const output = run(stateDir);

  assert.deepEqual(output.approval, {
    approved: ["src/auth.ts", "docs/api.md", "README.md"],
    unapproved: ["src/errors.ts"],
    swept: ["docs/api.md", "README.md"],
  });
  assert.deepEqual(output.count, {
    approved: 3,
    unapproved: 1,
    swept: 2,
    total: 4,
    omitted: 0,
    has_more: false,
  });
});

test("a review too big to print stops at the cap and still counts every file", () => {
  const stateDir = bigState(DEFAULT_PATH_LIMIT + 2);

  const output = run(stateDir);

  assert.equal((asRecord(output.approval).unapproved as string[]).length, DEFAULT_PATH_LIMIT);
  assert.deepEqual(output.count, {
    approved: 0,
    unapproved: DEFAULT_PATH_LIMIT + 2,
    swept: 0,
    total: DEFAULT_PATH_LIMIT + 2,
    omitted: 2,
    has_more: true,
  });
});

test("--full names every path the cap held back", () => {
  const stateDir = bigState(DEFAULT_PATH_LIMIT + 2);

  const output = run(stateDir, true);

  assert.equal((asRecord(output.approval).unapproved as string[]).length, DEFAULT_PATH_LIMIT + 2);
  assert.equal(asRecord(output.count).omitted, 0);
  assert.equal(asRecord(output.count).has_more, false);
});

test("a listing the cap cut says which flag prints the rest", () => {
  const help = (run(bigState(DEFAULT_PATH_LIMIT + 2)).help as string[]).join("\n");

  assert.match(help, /--full/);
  assert.match(help, new RegExp(String(DEFAULT_PATH_LIMIT)));
});

test("a listing that fit does not offer a flag there is nothing left to lift", () => {
  const whole = (run(bigState(DEFAULT_PATH_LIMIT)).help as string[]).join("\n");
  const asked = (run(bigState(DEFAULT_PATH_LIMIT + 2), true).help as string[]).join("\n");

  assert.doesNotMatch(whole, /--full/);
  assert.doesNotMatch(asked, /--full/);
});

test("parses the branch, the base and the flag that lifts the cap", () => {
  assert.deepEqual(parseApprovalsArgs(["feature-auth", "develop", "--full"]), {
    branch: "feature-auth",
    base: "develop",
    full: true,
  });
  assert.deepEqual(parseApprovalsArgs([]), {
    branch: undefined,
    base: undefined,
    full: false,
  });
});

test("a mistyped flag is refused rather than read as a branch name", () => {
  assert.throws(
    () => parseApprovalsArgs(["--fulll"]),
    (error: unknown) => {
      assert.match((error as Error).message, /unknown flag --fulll/);
      return true;
    },
  );
});

test("an ended review is answered as long as it is on disk, server or no server", () => {
  const stateDir = stateWith(
    session({ status: "ended", groups: [group("Auth", "study", "src/auth.ts")] }),
  );

  const output = run(stateDir);

  assert.equal((output.session as { status: string }).status, "ended");
  assert.equal(
    (output.help as string[])[0],
    "This review is over; these are the ticks it ended on",
  );
});

test("an open review's ticks are reported as a tally so far and not as a verdict", () => {
  const stateDir = stateWith(session({ groups: [group("Auth", "study", "src/auth.ts")] }));

  const output = run(stateDir);

  assert.equal(
    (output.help as string[])[0],
    "This review is still open, so these are the ticks so far and not a verdict",
  );
});

test("a swept file is named as accepted and not as read", () => {
  const stateDir = stateWith(
    session({
      status: "ended",
      groups: [group("Docs", "sweep", "docs/api.md")],
      approved: ["docs/api.md"],
    }),
  );

  assert.ok(
    (run(stateDir).help as string[]).some(
      (line) => line.includes("`swept`") && line.includes("accepted and not read"),
    ),
  );
});

test("a review nobody started is a named failure, not an empty account", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-approvals-"));

  assert.throws(
    () => run(stateDir),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "session_not_found" &&
      error.message.includes(sessionKey(REPO, BRANCH, BASE)),
  );
});
