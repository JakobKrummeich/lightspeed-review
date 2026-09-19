import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  helpAsk,
  helpNextRound,
  helpPublishAndWait,
  helpSay,
  helpWork,
  nextMoves,
} from "../../src/commands/home.ts";
import { parseSayArgs, runSay } from "../../src/commands/say.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer } from "../../src/server.ts";
import { SessionStore, type SessionRecord } from "../../src/session-store.ts";

const REPO = "/repo";
const BRANCH = "feature-auth";
const BASE = "main";
const KEY = sessionKey(REPO, BRANCH, BASE);
const AT = "2025-01-01T00:00:00.000Z";

const annotation = {
  type: "annotation" as const,
  id: "evt_a",
  file: "src/api/users.ts",
  group: "API Handlers",
  selected_text: "+const user = 1;",
  comment: "wrap in a transaction",
};

/** A session whose reviewer comment already carries its minted id, so it can be declared against. */
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
    conversation: [{ role: "reviewer", at: AT, roundIndex: 0, prompts: [annotation] }],
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
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-say-")));
  store.save(record);
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store });
  } finally {
    await server.stop();
  }
}

test("the text comes first, and the flags that pin it follow", () => {
  const parsed = parseSayArgs([
    "wrapped it",
    "feature-auth",
    "develop",
    "--for",
    "evt_a",
    "--files",
    "src/a.ts, src/b.ts",
  ]);

  assert.equal(parsed.message, "wrapped it");
  assert.equal(parsed.branch, "feature-auth");
  assert.equal(parsed.base, "develop");
  assert.equal(parsed.for, "evt_a");
  assert.deepEqual(parsed.files, ["src/a.ts", "src/b.ts"]);
});

test("speaking without pinning names no comment and no files", () => {
  const parsed = parseSayArgs(["wrapped it"]);

  assert.equal(parsed.for, undefined);
  assert.deepEqual(parsed.files, []);
});

/** Files belonging to no comment answer a question nobody asked: the
 * between-round diff already says what moved. */
test("--files without the --for it describes is refused", () => {
  assert.throws(
    () => parseSayArgs(["done", "--files", "src/a.ts"]),
    (error: unknown) => {
      assert.match((error as Error).message, /--files needs the --for it describes/);
      return true;
    },
  );
});

test("a --files that lists nothing is a mistake, not an empty list", () => {
  for (const value of [",", " , "]) {
    assert.throws(
      () => parseSayArgs(["done", "--for", "evt_a", "--files", value]),
      (error: unknown) => {
        assert.match((error as Error).message, /--files needs a comma-separated list/);
        return true;
      },
      value,
    );
  }
});

test("an unknown flag fails loud instead of being read as a branch name", () => {
  assert.throws(
    () => parseSayArgs(["done", "--fro", "evt_a"]),
    (error: unknown) => {
      assert.match((error as Error).message, /unknown flag --fro/);
      return true;
    },
  );
});

test("plain speech lands in the conversation as the agent's words", async () => {
  await withServer(session(), async ({ port, store }) => {
    const output = await runSay({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      text: "wrapped it in a transaction",
    });

    const entry = store.get(KEY)?.conversation.at(-1);
    assert.equal(entry?.role, "agent");
    assert.deepEqual(entry?.prompts, [{ type: "message", comment: "wrapped it in a transaction" }]);
    assert.equal(output.said, "wrapped it in a transaction");
  });
});

/**
 * Saying something changes nothing about whose move it is: an agent that answers
 * one comment and keeps editing is still editing, and a Send that flickered on
 * between its sentences would be worse than one that stays off.
 */
test("speaking leaves the turn where it was, and offers the moves that fit it", async () => {
  await withServer(session(), async ({ port, store }) => {
    const output = await runSay({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      text: "still on it",
    });

    assert.equal(store.get(KEY)?.turn.holder, "agent");
    assert.equal(output.turn, "agent reading");
    assert.equal(output.round, 1);
    // The whole array: a joined string hid a `wait` here that the server refuses
    // with exit 2 for as long as the turn is the agent's.
    assert.deepEqual(output.help, [
      helpWork("feature-auth main"),
      helpSay("feature-auth main"),
      helpAsk("feature-auth main"),
      helpNextRound("feature-auth main"),
    ]);
  });
});

/** The same, from mid-edit: `work` is already declared, so the moves left are
 * the ones that give the turn up deliberately — never a `wait`, which the poll
 * refuses with `turn_still_yours` while the agent is working. */
test("speaking mid-edit offers the moves that give the turn up, not a wait", async () => {
  const record = session({
    turn: { holder: "agent", mode: "working", at: AT, note: "splitting the helper out" },
  });
  await withServer(record, async ({ port }) => {
    const output = await runSay({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      text: "halfway through",
    });

    assert.equal(output.turn, "agent working");
    assert.deepEqual(output.help, [
      helpPublishAndWait("feature-auth main"),
      helpAsk("feature-auth main"),
      helpSay("feature-auth main"),
    ]);
  });
});

test("speaking without the turn offers only the wait that would earn one", async () => {
  const record = session({ turn: { holder: "reviewer", at: AT } });
  await withServer(record, async ({ port }) => {
    const output = await runSay({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      text: "just so you know",
    });

    assert.equal(output.turn, "reviewer");
    assert.deepEqual(output.help, [
      "Run `lightspeed wait feature-auth main` in the foreground to take the turn when the" +
        " reviewer sends — it blocks until the reviewer sends, so never background it or wrap" +
        " it in a timeout",
    ]);
  });
});

/**
 * `--for` pins the whole answer under the comment it answers, where the reviewer
 * is already looking, and says nothing in the open: the same sentence in both
 * places would read as the agent saying it twice.
 */
test("a pinned answer lands as a declaration and adds no line to the conversation", async () => {
  await withServer(session(), async ({ port, store }) => {
    const output = await runSay({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      text: "one transaction now",
      for: "evt_a",
      files: ["src/api/users.ts"],
    });

    // Both halves of the title, and neither is readable off the output: only
    // `say --for` could have written this declaration, and only a second, wrong
    // filing would add the same sentence to the conversation.
    assert.partialDeepStrictEqual(store.get(KEY)?.declarations, {
      evt_a: { note: "one transaction now", files: ["src/api/users.ts"] },
    });
    assert.equal(store.get(KEY)?.conversation.length, 1);
    assert.equal(output.for, "evt_a");
    assert.deepEqual(output.files, ["src/api/users.ts"]);
  });
});

test("a pin naming no comment of this review is refused whole", async () => {
  await withServer(session(), async ({ port, store }) => {
    await assert.rejects(
      () =>
        runSay({
          repoRoot: REPO,
          branch: BRANCH,
          base: BASE,
          port,
          text: "fixed",
          for: "evt_nope",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "declaration_invalid");
        assert.match(error.detail ?? "", /evt_nope/);
        return true;
      },
    );
    // Rejected whole: nothing of it was stored. That the server rejects it whole
    // is its own test; what this one owes is that the CLI stored nothing either.
    assert.equal(store.get(KEY)?.declarations, undefined);
  });
});

/** The reviewer has gone and their page is showing the closing summary: words
 * filed there reach nobody, and only they ask for another round. */
test("speaking into an ended review is refused, not filed where nobody looks", async () => {
  await withServer(session({ status: "ended", endedBy: "reviewer" }), async ({ port, store }) => {
    await assert.rejects(
      () => runSay({ repoRoot: REPO, branch: BRANCH, base: BASE, port, text: "one more thing" }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_ended");
        assert.match(error.suggestions.join("\n"), /--reopen/);
        return true;
      },
    );
    assert.equal(store.get(KEY)?.conversation.length, 1);
  });
});

/**
 * A server that took the words anyway — one older than the guard above. The help
 * must not offer a `wait`: on an ended review it returns "ended" at once, every
 * time, and an agent told to run it reads that as something still to come.
 */
test("an answer saying the review ended points at the only command that reopens one", async () => {
  const server: Server = createServer((request, response) => {
    const body = request.url === "/health" ? {} : { turn: "ended", round: 1, delivered: true };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const output = await runSay({ repoRoot: REPO, branch: BRANCH, base: BASE, port, text: "hi" });

    assert.equal(output.turn, "ended");
    assert.deepEqual(output.help, [
      'Run `lightspeed start feature-auth main --reopen --intent "<why>"`' +
        " once the reviewer asks for one",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("speaking into an unknown session fails with session_not_found", async () => {
  await withServer(session(), async ({ port }) => {
    await assert.rejects(
      () => runSay({ repoRoot: REPO, branch: "other", base: BASE, port, text: "hello" }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_not_found");
        return true;
      },
    );
  });
});

/**
 * S4: an agent that answers a comment mid-edit has already read this round's
 * moves off the `wait` that delivered the comment — 73% of this answer was that
 * same block again.
 */
test("an answer later in the round closes with one line, not the block again", async () => {
  const record = session({
    turn: { holder: "agent", mode: "working", at: AT, note: "switching mint() to a keyed hash" },
    helpShownRound: 1,
    conversation: [
      {
        role: "reviewer",
        at: AT,
        roundIndex: 0,
        prompts: [{ ...annotation, id: "evt_0mu83xjhi_0005" }],
      },
    ],
  });
  await withServer(record, async ({ port }) => {
    const output = await runSay({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      text: "renamed to userId and switched to an HMAC keyed off TOKEN_SECRET",
      for: "evt_0mu83xjhi_0005",
    });

    assert.equal(output.turn, "agent working");
    assert.equal(output.said, "renamed to userId and switched to an HMAC keyed off TOKEN_SECRET");
    assert.equal(output.for, "evt_0mu83xjhi_0005");
    assert.deepEqual(output.help, [nextMoves("agent working", "feature-auth main")]);
  });
});
