import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAskArgs, runAsk } from "../../src/commands/ask.ts";
import { runWait } from "../../src/commands/wait.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer } from "../../src/server.ts";
import { SessionStore, type SessionRecord } from "../../src/session-store.ts";

const REPO = "/repo";
const BRANCH = "feature-auth";
const BASE = "main";
const KEY = sessionKey(REPO, BRANCH, BASE);
const AT = "2025-01-01T00:00:00.000Z";

const answer = {
  type: "message" as const,
  comment: "yes, drop the retry entirely",
};

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
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-ask-")));
  store.save(record);
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store });
  } finally {
    await server.stop();
  }
}

test("the question comes first, then the session it is about", () => {
  const parsed = parseAskArgs(["should I drop the retry?", "feature-auth", "develop"]);

  assert.equal(parsed.message, "should I drop the retry?");
  assert.equal(parsed.branch, "feature-auth");
  assert.equal(parsed.base, "develop");
});

test("ask takes no flags, and a blank question is refused", () => {
  assert.throws(
    () => parseAskArgs(["why?", "--politely"]),
    (error: unknown) => {
      assert.match((error as Error).message, /unknown flag --politely/);
      return true;
    },
  );
  assert.throws(
    () => parseAskArgs([""]),
    (error: unknown) => {
      assert.match((error as Error).message, /ask needs the question to put to the reviewer/);
      return true;
    },
  );
});

/**
 * The question goes into the conversation as a card with its own answer box, and
 * the turn goes back so the reviewer can use it — then the same block every
 * delivery comes through. Feedback queued up front stands in for the reviewer
 * answering, so the wait ends without a second connection to race.
 */
test("the question is delivered as a question, and the answer comes back on the same call", async () => {
  await withServer(session({ pending: [answer] }), async ({ port, store }) => {
    const output = await runAsk({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      question: "should I drop the retry?",
    });

    // The one thing only this test can prove: `ask` puts `kind: "question"` on
    // the wire, which is what draws the card with its own answer box. The rest of
    // what the record holds is the server's contract, and tested there.
    assert.partialDeepStrictEqual(store.get(KEY)?.conversation.at(0)?.prompts, [
      { type: "message", comment: "should I drop the retry?", kind: "question" },
    ]);
    assert.deepEqual(output.prompts, [answer]);
  });
});

/** The answer reads exactly as a `wait` does: same output, same help. */
test("the answer is reported in the shape wait reports one", async () => {
  await withServer(session({ pending: [answer] }), async ({ port }) => {
    const output = await runAsk({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      question: "should I drop the retry?",
    });

    assert.equal(output.turn, "agent reading");
    assert.equal(output.round, 1);
    assert.equal(output.status, "feedback");
    assert.equal(output.ended, false);
    assert.match(
      (output.help as string[]).join("\n"),
      /lightspeed work "<plan>" feature-auth main/,
    );
  });
});

/**
 * N2: the answer arrives minutes or hours later, and an agent that was compacted
 * in between reads "Env var, same as every other secret here" with no idea what
 * it asked. The question rides back out with its answer.
 */
test("the answer carries the question it answers", async () => {
  await withServer(session({ pending: [answer] }), async ({ port }) => {
    const output = await runAsk({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      question: "should the key live in env or in the config file?",
    });

    assert.equal(output.asked, "should the key live in env or in the config file?");
    // Above the answer it belongs to, and never in place of it.
    assert.deepEqual(Object.keys(output).slice(0, 3), ["turn", "round", "asked"]);
    assert.deepEqual(output.prompts, [answer]);
  });
});

/** Only `ask` has a question to echo; a plain `wait` must not grow an empty one. */
test("a plain wait carries no question", async () => {
  await withServer(session({ pending: [answer] }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.ok(!("asked" in output));
  });
});

/** Asking hands the turn back: the agent cannot go on without an answer, so the
 * reviewer's Send has to be live for them to give one. */
test("asking from a turn the agent holds hands it back before the wait blocks", async () => {
  const record = session({
    turn: { holder: "agent", mode: "working", at: AT, note: "splitting the helper out" },
    pending: [answer],
  });
  await withServer(record, async ({ port, store }) => {
    await runAsk({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      question: "is this what you meant?",
    });

    // Handed back by the question and taken again by the delivery that answered it.
    assert.equal(store.get(KEY)?.turn.holder, "agent");
    assert.partialDeepStrictEqual(store.get(KEY)?.turn, { mode: "reading" });
  });
});

/** Nobody is there to answer, so the question is refused rather than asked into
 * the closing summary and waited on. */
test("a question put to an ended review is refused instead of blocking on an answer", async () => {
  await withServer(session({ status: "ended", endedBy: "reviewer" }), async ({ port, store }) => {
    await assert.rejects(
      () =>
        runAsk({ repoRoot: REPO, branch: BRANCH, base: BASE, port, question: "anything else?" }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_ended");
        assert.match(error.suggestions.join("\n"), /--reopen/);
        return true;
      },
    );
    assert.deepEqual(store.get(KEY)?.conversation, []);
  });
});

test("asking in an unknown session fails with session_not_found instead of blocking", async () => {
  await withServer(session(), async ({ port }) => {
    await assert.rejects(
      () => runAsk({ repoRoot: REPO, branch: "other", base: BASE, port, question: "hello?" }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_not_found");
        return true;
      },
    );
  });
});

/** N3: the two places an agent reads what `ask` takes must not disagree — the
 * missing-argument error said `<text>` while `ask --help` said `<question>`. */
test("the missing-question error names a question, the same as `ask --help`", () => {
  assert.throws(
    () => parseAskArgs([]),
    (error: unknown) => {
      assert.match((error as Error).message, /ask needs the question to put to the reviewer/);
      assert.match((error as { suggestions: string[] }).suggestions[0]!, /ask "<question>"/);
      return true;
    },
  );
});
