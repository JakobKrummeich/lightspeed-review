import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { git, newRepo } from "../helpers/git-repo.ts";
import { freePort } from "../helpers/ports.ts";
import type { StructuredOutput } from "../../src/output.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnd } from "../../src/commands/end.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import type { SessionRecord } from "../../src/session-types.ts";
import { agentWorking } from "../../src/turn.ts";

const REPO = "/repo";
const BRANCH = "feature-auth";
const BASE = "main";

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
    turn: { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

async function withServer(
  record: SessionRecord | undefined,
  body: (context: { port: number; store: SessionStore; stateDir: string }) => Promise<void>,
): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-end-"));
  const store = new SessionStore(stateDir);
  if (record) store.save(record);
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store, stateDir });
  } finally {
    await server.stop();
  }
}

test("closes the session and reports it as ended", async () => {
  await withServer(session(), async ({ port, store, stateDir }) => {
    const output = await runEnd({ repoRoot: REPO, branch: BRANCH, base: BASE, port, stateDir });

    assert.equal(store.get(sessionKey(REPO, BRANCH, BASE))?.status, "ended");
    // The turn says it is over; a second word for the same fact is one an agent
    // has to reconcile, and the one that goes stale.
    assert.equal(output.turn, "ended");
    assert.ok(!("status" in (output.session as object)));
    // Reopening is the reviewer's call, so the only move named is the one they ask for.
    assert.match(
      (output.next as { done: string }).done,
      /lightspeed open feature-auth main --reopen/,
    );
  });
});

test("ending an unknown session fails with session_not_found", async () => {
  await withServer(undefined, async ({ port, stateDir }) => {
    await assert.rejects(
      () => runEnd({ repoRoot: REPO, branch: BRANCH, base: BASE, port, stateDir }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_not_found");
        return true;
      },
    );
  });
});

/** Idempotent, and says so: "closed" alone read as this call having closed it. */
test("ending a review that is already ended says it was already ended", async () => {
  await withServer(
    session({ status: "ended", endedBy: "reviewer" }),
    async ({ port, stateDir }) => {
      const output = await runEnd({ repoRoot: REPO, branch: BRANCH, base: BASE, port, stateDir });

      assert.equal(output.turn, "ended");
      assert.match(String(output.message), /already ended/);
      assert.equal(output.help, undefined);
    },
  );
});

interface Branch {
  repoRoot: string;
  /** The tip the last round showed. */
  published: string;
}

/** A commit that changes a file: empty commits share one patch-id, which would hide a rewrite. */
function commitFile(repoRoot: string, name: string, message = name): void {
  writeFileSync(join(repoRoot, name), `${name}\n`);
  git(repoRoot, "add", name);
  git(repoRoot, "commit", "-q", "-m", message);
}

/** A real branch whose tip is the last round's HEAD, off a `main` that may move on. */
function branchAtRound(): Branch {
  const repoRoot = newRepo("lsr-end-repo-");
  commitFile(repoRoot, "base.txt");
  git(repoRoot, "checkout", "-q", "-b", BRANCH);
  commitFile(repoRoot, "round-1.txt");
  return { repoRoot, published: git(repoRoot, "rev-parse", "HEAD") };
}

/** Three commits land on main after the round was published. */
function advanceMain({ repoRoot }: Branch): void {
  git(repoRoot, "checkout", "-q", BASE);
  for (const name of ["main-1.txt", "main-2.txt", "main-3.txt"]) commitFile(repoRoot, name);
  git(repoRoot, "checkout", "-q", BRANCH);
}

function workingOn({ repoRoot, published }: Branch): SessionRecord {
  return session({
    key: sessionKey(repoRoot, BRANCH, BASE),
    repoRoot,
    rounds: [{ index: 0, at: AT, files: [], approvedAtEnd: [], headCommit: published }],
    turn: agentWorking(AT, "the plan"),
  });
}

const AT = "2025-01-01T00:00:00.000Z";

async function endWorking(branch: Branch): Promise<StructuredOutput> {
  let output: StructuredOutput = {};
  await withServer(workingOn(branch), async ({ port, store, stateDir }) => {
    const repoRoot = branch.repoRoot;
    output = await runEnd({ repoRoot, branch: BRANCH, base: BASE, port, stateDir });
    assert.equal(store.get(sessionKey(repoRoot, BRANCH, BASE))?.status, "ended");
  });
  return output;
}

function warning(output: StructuredOutput): string | undefined {
  return (output.help as string[] | undefined)?.join("\n");
}

/**
 * Ending is never refused, but commits made after `work` and never published
 * are work the reviewer never saw: the agent is told, so its user can be.
 */
test("ending while working with commits the last round lacks warns, and still ends", async () => {
  const branch = branchAtRound();
  commitFile(branch.repoRoot, "unpublished-1.txt");
  commitFile(branch.repoRoot, "unpublished-2.txt");

  const output = await endWorking(branch);

  assert.match(
    warning(output) ?? "",
    /2 commits on feature-auth since round 1 never reached the reviewer/,
  );
  // The way to show them is next.done's --reopen line; said once, not twice.
  assert.match(warning(output) ?? "", /--reopen/);
  assert.doesNotMatch(warning(output) ?? "", /lightspeed open/);
  assert.match(
    (output.next as { done: string }).done,
    /lightspeed open feature-auth main --reopen/,
  );
});

test("ending while working with nothing committed since the last round warns of nothing", async () => {
  const output = await endWorking(branchAtRound());

  assert.equal(output.turn, "ended");
  assert.equal(output.help, undefined);
});

/** main's commits came in with the merge: the reviewer's base, not the agent's work. */
test("merging main into the branch is not unpublished work", async () => {
  const branch = branchAtRound();
  advanceMain(branch);
  git(branch.repoRoot, "merge", "-q", "--no-edit", BASE);

  assert.equal((await endWorking(branch)).help, undefined);
});

/** A rebase rewrites the published commits, but the reviewer saw every change in them. */
test("rebasing the branch onto a newer main is not unpublished work", async () => {
  const branch = branchAtRound();
  advanceMain(branch);
  git(branch.repoRoot, "rebase", "-q", BASE);

  assert.equal((await endWorking(branch)).help, undefined);
});

test("a new commit on a rebased branch is counted, and only it", async () => {
  const branch = branchAtRound();
  advanceMain(branch);
  git(branch.repoRoot, "rebase", "-q", BASE);
  commitFile(branch.repoRoot, "unpublished.txt");

  assert.match(warning(await endWorking(branch)) ?? "", /^1 commit on feature-auth since round 1/);
});

/** git cannot say what is new, so nothing is claimed — and the review still ends. */
test("ending while working on a branch git no longer has ends without a warning", async () => {
  const branch = branchAtRound();
  commitFile(branch.repoRoot, "unpublished.txt");
  git(branch.repoRoot, "checkout", "-q", BASE);
  git(branch.repoRoot, "branch", "-q", "-D", BRANCH);

  const output = await endWorking(branch);

  assert.equal(output.turn, "ended");
  assert.equal(output.help, undefined);
});

/** The record already says it is over: nothing to ask a server that is not there. */
test("ending a review the session file shows as ended needs no server", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-end-"));
  new SessionStore(stateDir).save(session({ status: "ended", endedBy: "reviewer" }));

  const output = await runEnd({
    repoRoot: REPO,
    branch: BRANCH,
    base: BASE,
    port: await freePort(),
    stateDir,
  });

  assert.equal(output.turn, "ended");
  assert.match(String(output.message), /already ended/);
});
