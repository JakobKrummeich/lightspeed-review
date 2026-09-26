import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { git, newRepo } from "../helpers/git-repo.ts";
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

/** A real branch whose tip is the last round's HEAD. */
function branchAtRound(): Branch {
  const repoRoot = newRepo("lsr-end-repo-");
  git(repoRoot, "commit", "--allow-empty", "-m", "base");
  git(repoRoot, "checkout", "-b", BRANCH);
  git(repoRoot, "commit", "--allow-empty", "-m", "round 1");
  return { repoRoot, published: git(repoRoot, "rev-parse", "HEAD") };
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

/**
 * Ending is never refused, but commits made after `work` and never published
 * are work the reviewer never saw: the agent is told, so its user can be.
 */
test("ending while working with commits the last round lacks warns, and still ends", async () => {
  const branch = branchAtRound();
  git(branch.repoRoot, "commit", "--allow-empty", "-m", "unpublished 1");
  git(branch.repoRoot, "commit", "--allow-empty", "-m", "unpublished 2");
  await withServer(workingOn(branch), async ({ port, store, stateDir }) => {
    const repoRoot = branch.repoRoot;
    const output = await runEnd({ repoRoot, branch: BRANCH, base: BASE, port, stateDir });

    assert.equal(store.get(sessionKey(repoRoot, BRANCH, BASE))?.status, "ended");
    const help = (output.help as string[]).join("\n");
    assert.match(help, /2 commits on feature-auth since round 1 never reached the reviewer/);
    assert.match(help, /lightspeed open feature-auth main --reopen/);
  });
});

test("ending while working with nothing committed since the last round warns of nothing", async () => {
  const branch = branchAtRound();
  await withServer(workingOn(branch), async ({ port, stateDir }) => {
    const repoRoot = branch.repoRoot;
    const output = await runEnd({ repoRoot, branch: BRANCH, base: BASE, port, stateDir });

    assert.equal(output.turn, "ended");
    assert.equal(output.help, undefined);
  });
});
