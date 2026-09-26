import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRule } from "../../src/turn-help.ts";
import { parseWorkArgs, runWork } from "../../src/commands/work.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import type { SessionRecord } from "../../src/session-types.ts";

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
    turn: { holder: "agent", mode: "digesting", at: AT },
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

test("branch and base are left unset so the session can be resolved from the repository", () => {
  const parsed = parseWorkArgs(["splitting the helper out"]);

  assert.equal(parsed.branch, undefined);
  assert.equal(parsed.base, undefined);
});

/** A second real ref would otherwise hide the words the shell split off an unquoted plan. */
test("words past the plan, the branch and the base are refused, naming the quoted plan", () => {
  assert.throws(
    () => parseWorkArgs(["splitting", "feature-auth", "main", "stray"]),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "invalid_arguments");
      assert.match((error as Error).message, /work got more than a branch and a base/);
      assert.match(
        (error as { suggestions: string[] }).suggestions.join("\n"),
        /lightspeed work '<the whole plan>' \[branch\] \[base\]/,
      );
      return true;
    },
  );
});

test("a plan that looks like a flag value is still the plan", () => {
  assert.equal(parseWorkArgs(["-1 helper, see notes"]).message, "-1 helper, see notes");
});

/** The example in the error names the argument `--help` names: one name for one thing. */
test("a missing plan is refused with an example naming the plan", () => {
  assert.throws(
    () => parseWorkArgs([]),
    (error: unknown) => {
      assert.match((error as Error).message, /work needs the plan you are about to carry out/);
      assert.match((error as { suggestions: string[] }).suggestions[0]!, /work "<plan>"/);
      return true;
    },
  );
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

test("a blank plan is refused: the header would name nothing", () => {
  assert.throws(
    () => parseWorkArgs(["  "]),
    (error: unknown) => {
      assert.match((error as Error).message, /work needs the plan you are about to carry out/);
      return true;
    },
  );
});

test("declaring the plan names it on the turn the agent already holds", async () => {
  await withServer(session(), async ({ port }) => {
    const output = await runWork({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      plan: "splitting the helper out",
    });

    assert.equal(output.turn, "agent working");
    assert.equal(output.round, 1);
    assert.equal(output.plan, "splitting the helper out");
    assert.equal(
      output.message,
      "the reviewer's header names this plan; they can queue, not send, until you publish",
    );
  });
});

/** Work waits for nothing, so its answer closes with the one way out: publish. */
test("the answer after work closes with the rule for a working turn", async () => {
  await withServer(session(), async ({ port }) => {
    const output = await runWork({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      plan: "splitting the helper out",
    });

    assert.deepEqual(output.next, nextRule("agent working", "feature-auth main"));
    assert.equal(Object.keys(output).at(-1), "next");
    assert.match(
      (output.next as { publish: string }).publish,
      /lightspeed publish feature-auth main/,
    );
  });
});

/** The publish line names what the agent is holding, so its `--to` is copied, not guessed. */
test("the publish line after work names the batch's open item", async () => {
  const asked = { type: "message" as const, id: "t3", comment: "why a new table?" };
  const record = session({
    conversation: [{ role: "reviewer", at: AT, prompts: [asked] }],
    batch: { id: "dlv_1", at: AT, prompts: [asked], acked: true },
  });
  await withServer(record, async ({ port }) => {
    const output = await runWork({ repoRoot: REPO, branch: BRANCH, base: BASE, port, plan: "fix" });

    assert.match((output.next as { publish: string }).publish, /--to t3 'done: /);
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

    assert.equal(again.message, "the reviewer's header already names this plan (no-op)");
    assert.match(String(refined.message), /^the reviewer's header names this plan;/);
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
        assert.match(error.suggestions.join("\n"), /lightspeed open feature-auth main/);
        return true;
      },
    );
    assert.equal(store.get(KEY)?.turn.holder, "reviewer");
  });
});

/** Regression: the turn on an ended record is whoever held it last, and `work`
 * from that agent was written onto the closed session. */
test("work on an ended review is refused as ended, and declares nothing", async () => {
  const record = session({ status: "ended", turn: { holder: "agent", mode: "digesting", at: AT } });
  await withServer(record, async ({ port, store }) => {
    await assert.rejects(
      () => runWork({ repoRoot: REPO, branch: BRANCH, base: BASE, port, plan: "carrying on" }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_ended");
        // What the review ended on is the answer the agent is after next.
        assert.match(error.suggestions[0]!, /lightspeed approvals feature-auth main/);
        assert.match(error.suggestions.join("\n"), /--reopen/);
        return true;
      },
    );
    assert.deepEqual(store.get(KEY)?.turn, { holder: "agent", mode: "digesting", at: AT });
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

/** W2: the branch tip `work` found is what a later `reply` from working is measured against. */
test("redeclaring keeps the head the work started from", async () => {
  await withServer(session(), async ({ port, store }) => {
    const input = { repoRoot: REPO, branch: BRANCH, base: BASE, port };
    await runWork({ ...input, plan: "splitting the helper out" });
    const first = store.get(KEY)!.turn;
    store.save({ ...store.get(KEY)!, turn: { ...first, head: "c".repeat(40) } as typeof first });

    await runWork({ ...input, plan: "and re-running the suite" });

    const turn = store.get(KEY)!.turn;
    assert.equal(turn.holder === "agent" && turn.mode === "working" && turn.head, "c".repeat(40));
    assert.equal(
      turn.holder === "agent" && turn.mode === "working" && turn.note,
      "and re-running the suite",
    );
  });
});
