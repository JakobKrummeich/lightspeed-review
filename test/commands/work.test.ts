import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpAsk, helpPublishAndWait, helpSay } from "../../src/commands/home.ts";
import { parseWorkArgs, runWork } from "../../src/commands/work.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer } from "../../src/server.ts";
import { SessionStore, type SessionRecord } from "../../src/session-store.ts";

const REPO = "/repo";
const BRANCH = "feature-auth";
const BASE = "main";
const KEY = sessionKey(REPO, BRANCH, BASE);
const AT = "2025-01-01T00:00:00.000Z";

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: KEY,
    repoRoot: REPO,
    branch: BRANCH,
    base: BASE,
    status: "feedback",
    turn: { holder: "agent", mode: "reading", at: AT },
    createdAt: AT,
    updatedAt: AT,
    groups: [],
    conversation: [],
    pending: [],
    approved: [],
    rounds: [{ index: 0, at: AT, files: [], approvedAtEnd: [] }],
    ...overrides,
  };
}

async function withServer(
  record: SessionRecord,
  body: (context: { port: number; store: SessionStore }) => Promise<void>,
): Promise<void> {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-work-")));
  store.save(record);
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store });
  } finally {
    await server.stop();
  }
}

test("the plan comes first, then the session it is about", () => {
  const parsed = parseWorkArgs(["splitting the helper out", "feature-auth", "develop"]);

  assert.equal(parsed.message, "splitting the helper out");
  assert.equal(parsed.branch, "feature-auth");
  assert.equal(parsed.base, "develop");
});

test("work takes no flags, and says so rather than listing none", () => {
  assert.throws(
    () => parseWorkArgs(["splitting", "--quietly"]),
    (error: unknown) => {
      assert.match((error as Error).message, /unknown flag --quietly/);
      assert.match(
        (error as { suggestions: string[] }).suggestions.join("\n"),
        /`lightspeed work` takes no flags/,
      );
      return true;
    },
  );
});

test("a blank plan is refused: the banner would name nothing", () => {
  assert.throws(
    () => parseWorkArgs(["  "]),
    (error: unknown) => {
      assert.match((error as Error).message, /work needs the plan you are about to go quiet over/);
      return true;
    },
  );
});

/** `work` does not take the turn — it says what is being done with one already held. */
test("declaring the plan names it on the turn the agent already holds", async () => {
  await withServer(session(), async ({ port, store }) => {
    const output = await runWork({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      plan: "splitting the helper out",
    });

    assert.partialDeepStrictEqual(store.get(KEY)?.turn, {
      holder: "agent",
      mode: "working",
      note: "splitting the helper out",
    });
    assert.equal(output.turn, "agent working");
    assert.equal(output.round, 1);
    assert.equal(output.plan, "splitting the helper out");
    assert.equal(output.message, "the reviewer's banner names this plan until you speak again");
  });
});

/** The happy path used to close with `lightspeed wait`, which the poll refuses
 * with `turn_still_yours` and exit 2 the moment this command succeeds. The whole
 * array is asserted because a joined string is what hid it. */
test("the moves after work are the ones that give the turn up, never a wait", async () => {
  await withServer(session(), async ({ port }) => {
    const output = await runWork({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      plan: "splitting the helper out",
    });

    assert.deepEqual(output.help, [
      helpPublishAndWait("feature-auth main"),
      helpAsk("feature-auth main"),
      helpSay("feature-auth main"),
    ]);
  });
});

/** An agent that re-runs `work` after a crash must not be told it announced
 * something new; one that refines its plan must be told it did. */
test("redeclaring the same plan says so, and refining it does not", async () => {
  await withServer(session(), async ({ port }) => {
    const input = { repoRoot: REPO, branch: BRANCH, base: BASE, port };
    await runWork({ ...input, plan: "splitting the helper out" });

    const again = await runWork({ ...input, plan: "splitting the helper out" });
    const refined = await runWork({ ...input, plan: "splitting the helper out, then the test" });

    assert.equal(again.message, "the reviewer's banner already named this plan (no-op)");
    assert.equal(refined.message, "the reviewer's banner names this plan until you speak again");
  });
});

/** The one illegal move in the protocol, and the only place `turn_not_yours`
 * comes from: an agent that declares work on feedback nobody sent it. */
test("work without the turn is refused, with the command that earns it", async () => {
  const record = session({ turn: { holder: "reviewer", at: AT } });
  await withServer(record, async ({ port, store }) => {
    await assert.rejects(
      () => runWork({ repoRoot: REPO, branch: BRANCH, base: BASE, port, plan: "guessing" }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "turn_not_yours");
        assert.match(error.suggestions.join("\n"), /lightspeed wait feature-auth main/);
        return true;
      },
    );
    assert.equal(store.get(KEY)?.turn.holder, "reviewer");
  });
});

/** The turn on an ended record is whoever held it last, not a move anyone can
 * make: `work` from that agent used to be written onto the closed session. It is
 * refused as ended, the way `say` and `ask` are refused. */
test("work on an ended review is refused as ended, and declares nothing", async () => {
  const record = session({ status: "ended", turn: { holder: "agent", mode: "reading", at: AT } });
  await withServer(record, async ({ port, store }) => {
    await assert.rejects(
      () => runWork({ repoRoot: REPO, branch: BRANCH, base: BASE, port, plan: "carrying on" }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_ended");
        assert.match(error.suggestions.join("\n"), /--reopen/);
        return true;
      },
    );
    assert.deepEqual(store.get(KEY)?.turn, { holder: "agent", mode: "reading", at: AT });
  });
});

test("declaring work on an unknown session fails with session_not_found", async () => {
  await withServer(session(), async ({ port }) => {
    await assert.rejects(
      () => runWork({ repoRoot: REPO, branch: "other", base: BASE, port, plan: "editing" }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_not_found");
        return true;
      },
    );
  });
});
