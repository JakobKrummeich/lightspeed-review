import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnd } from "../../src/commands/end.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import type { SessionRecord } from "../../src/session-types.ts";

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
  body: (context: { port: number; store: SessionStore }) => Promise<void>,
): Promise<void> {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-end-")));
  if (record) store.save(record);
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store });
  } finally {
    await server.stop();
  }
}

test("closes the session and reports it as ended", async () => {
  await withServer(session(), async ({ port, store }) => {
    const output = await runEnd({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
  await withServer(undefined, async ({ port }) => {
    await assert.rejects(
      () => runEnd({ repoRoot: REPO, branch: BRANCH, base: BASE, port }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_not_found");
        return true;
      },
    );
  });
});
