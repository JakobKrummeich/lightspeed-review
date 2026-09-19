import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpAsk, helpNextRound, helpReopen, helpSay, helpWork } from "../../src/commands/home.ts";
import { parseWaitArgs, runWait } from "../../src/commands/wait.ts";
import { ReviewError } from "../../src/errors.ts";
import { PROMPT_LIMIT, SELECTION_LIMIT } from "../../src/output.ts";
import { sessionKey } from "../../src/paths.ts";
import { CLI_VERSION } from "../../src/version.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore, type SessionRecord } from "../../src/session-store.ts";
import type { DiffGroup } from "../../src/diff-extract.ts";

/** A grouping of `paths`, which is all the ended output counts files off. */
function groups(...paths: string[]): DiffGroup[] {
  return [
    {
      name: "API Handlers",
      rationale: "the endpoints",
      files: paths.map((path) => ({
        path,
        status: "modified" as const,
        diff: `--- a/${path}\n+++ b/${path}\n`,
        insertions: 1,
        deletions: 0,
        oversized: false,
      })),
    },
  ];
}

function endedHelp(output: Awaited<ReturnType<typeof runWait>>): string {
  return (output.help as string[])[0]!;
}

const REPO = "/repo";
const BRANCH = "feature-auth";
const BASE = "main";

const annotation = {
  type: "annotation" as const,
  file: "src/api/users.ts",
  group: "API Handlers",
  selected_text: "+const user = 1;",
  comment: "wrap in a transaction",
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: sessionKey(REPO, BRANCH, BASE),
    repoRoot: REPO,
    branch: BRANCH,
    base: BASE,
    status: "open",
    turn: { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
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

/** A review server of another version: ours by `/health`, and speaking a
 * protocol this CLI no longer reads. */
function createStaleServer(version: string): Server {
  return createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", version }));
  });
}

async function withServer(
  record: SessionRecord | undefined,
  body: (context: { port: number; store: SessionStore; server: ReviewServer }) => Promise<void>,
): Promise<void> {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-wait-")));
  if (record) store.save(record);
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store, server });
  } finally {
    await server.stop();
  }
}

test("parses the branch and base it was pointed at", () => {
  assert.deepEqual(parseWaitArgs(["feature-auth", "develop"]), {
    branch: "feature-auth",
    base: "develop",
    full: false,
  });
});

test("leaves branch and base unset so the session can be resolved from the repository", () => {
  assert.deepEqual(parseWaitArgs([]), { branch: undefined, base: undefined, full: false });
});

test("--full is read off the command line", () => {
  assert.deepEqual(parseWaitArgs(["feature-auth", "--full"]), {
    branch: "feature-auth",
    base: undefined,
    full: true,
  });
});

test("an unknown flag fails loud instead of being read as a branch name", () => {
  assert.throws(
    () => parseWaitArgs(["--fully"]),
    (error: unknown) => {
      assert.match((error as Error).message, /unknown flag --fully/);
      return true;
    },
  );
});

test("returns the queued prompts once the reviewer sends", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.ended, false);
    assert.deepEqual(output.prompts, [annotation]);
  });
});

/**
 * N4: `status` restated what `turn` and `ended` already say, and said it out of
 * date — a session reads `feedback` for rounds after the feedback was consumed.
 * Two fields to reconcile where one is authoritative is how an agent reads a
 * round as unfinished.
 */
test("the answer states the turn, not a second stale word for it", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.turn, "agent reading");
    assert.ok(!("status" in output));
  });
});

/** The turn is what the next command is chosen against, so it leads the answer. */
test("a delivered wait says whose move it is and which round it is about", async () => {
  const record = session({
    pending: [annotation],
    status: "feedback",
    rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z", files: [], approvedAtEnd: [] }],
  });
  await withServer(record, async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.turn, "agent reading");
    assert.equal(output.round, 1);
    assert.deepEqual(Object.keys(output).slice(0, 2), ["turn", "round"]);
  });
});

/** The handover id is transport: the agent acts on the prompts, never on it. */
test("the delivery id the client acknowledges is never printed to the agent", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal("delivery" in output, false);
  });
});

/**
 * The moves that are legal from a delivered turn, in the order they are usually
 * wanted. `wait` is not among them: the agent holds the turn now.
 */
test("a delivered wait closes with the moves that are legal from there", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    // The whole array, not a substring of it joined up: a `wait` offered here is
    // refused with exit 2, and only an exact list can prove it is not offered.
    assert.deepEqual(output.help, [
      helpWork("feature-auth main"),
      helpSay("feature-auth main"),
      helpAsk("feature-auth main"),
      helpNextRound("feature-auth main"),
    ]);
  });
});

/**
 * S5: the guard sat at 2000 characters, so a 1226-character selection came back
 * whole — 372 tokens for one prompt, of text the agent can read in the file it
 * is standing in. The cut says where the rest is, which is what makes it a cut
 * and not a loss.
 */
test("a huge selection is cut where the reviewer's point is still visible", async () => {
  const huge = {
    ...annotation,
    file: "a.txt",
    side: "new" as const,
    line_start: 1,
    line_end: 1,
    selected_text: `const veryLongSelection = ${"x".repeat(1200)}`,
  };
  await withServer(session({ pending: [huge], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    const [prompt] = output.prompts as [{ selected_text: string }];
    // The cut itself, not merely "shorter": one character off would satisfy that,
    // and the point of the cut is that a page-long selection stays readable.
    assert.equal(
      prompt.selected_text,
      `${huge.selected_text.slice(0, SELECTION_LIMIT)}\n(truncated, 1226 chars — use --full;` +
        " lines 1-1 of a.txt have the rest)",
    );
  });
});

/** The comment is the reviewer's own words, and the only part of a prompt the
 * agent cannot read anywhere else. It is never cut. */
test("the reviewer's comment comes back whole however long it is", async () => {
  const wordy = { ...annotation, comment: "because ".repeat(400) };
  await withServer(session({ pending: [wordy], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    const [prompt] = output.prompts as [{ comment: string }];
    assert.equal(prompt.comment, wordy.comment);
  });
});

/** A round the reviewer spent an hour on can queue dozens of prompts; the whole
 * pile in one answer is a context an agent cannot act on either. */
test("a queue past the cap is cut with a count and the flag that prints it all", async () => {
  const many = Array.from({ length: PROMPT_LIMIT + 3 }, (_, index) => ({
    ...annotation,
    comment: `point ${index}`,
  }));
  await withServer(session({ pending: many, status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal((output.prompts as unknown[]).length, PROMPT_LIMIT);
    assert.equal(output.omitted, 3);
    assert.match(output.message as string, /--full/);
    // The one line an agent reads before it acts, so the cut is named there too.
    assert.match((output.help as string[])[0]!, /--full/);
  });
});

test("--full hands back every prompt the cap held back", async () => {
  const many = Array.from({ length: PROMPT_LIMIT + 3 }, (_, index) => ({
    ...annotation,
    comment: `point ${index}`,
  }));
  await withServer(session({ pending: many, status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port, full: true });

    assert.equal((output.prompts as unknown[]).length, PROMPT_LIMIT + 3);
    assert.ok(!("omitted" in output));
  });
});

test("--full hands back the selection exactly as the reviewer made it", async () => {
  const huge = { ...annotation, selected_text: "+".repeat(5000) };
  await withServer(session({ pending: [huge], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port, full: true });

    assert.deepEqual(output.prompts, [huge]);
  });
});

/**
 * N6: a `serve` process left over from an older install answered this CLI with
 * a payload that had no `turn` and no `round`, and the client defaulted its way
 * past it — so the agent read "agent reading" off a server that had never heard
 * of turns. A wait that cannot trust the answer must not block for one.
 */
test("a wait against a server of another version is refused, with the way to clear it", async () => {
  const stale = createStaleServer("0.0.1");
  await new Promise<void>((resolve) => stale.listen(0, "127.0.0.1", resolve));
  const { port } = stale.address() as { port: number };

  await assert.rejects(
    () => runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_stale");
      assert.match(error.message, /0\.0\.1/);
      assert.match(error.suggestions.join(" "), /lightspeed stop/);
      assert.match(error.suggestions.join(" "), /lightspeed wait feature-auth main/);
      return true;
    },
  );

  await new Promise<void>((resolve) => stale.close(() => resolve()));
});

test("an ended review reports it and stops suggesting another wait", async () => {
  await withServer(session({ status: "ended" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.ended, true);
    assert.equal(output.turn, "ended");
    assert.equal(output.prompts, 0);
    // The account, then the one move an ended review leaves — no `wait`, which
    // would return "ended" forever.
    assert.deepEqual((output.help as string[]).slice(1), [helpReopen("feature-auth main")]);
  });
});

test("a review the reviewer ended having approved every file reads as a sign-off", async () => {
  const record = session({
    status: "ended",
    endedBy: "reviewer",
    groups: groups("src/a.ts", "src/b.ts"),
    approved: ["src/a.ts", "src/b.ts"],
  });
  await withServer(record, async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    // The arithmetic is the payload's job: the words add only what it cannot say.
    assert.equal(endedHelp(output), "The reviewer ended this review; verdict: signed-off");
    assert.deepEqual(output.approval, {
      verdict: "signed-off",
      approved: 2,
      unapproved: 0,
      swept: 0,
      total: 2,
    });
    assert.equal(output.endedBy, "reviewer");
  });
});

test("a sign-off taken over a sweep lane says how much of it nobody read", async () => {
  const [chapter, lane] = [groups("src/a.ts")[0]!, groups("docs/api.md", "pnpm-lock.yaml")[0]!];
  const record = session({
    status: "ended",
    endedBy: "reviewer",
    groups: [
      { ...chapter, tier: "study" },
      { ...lane, name: "Docs and lockfiles", tier: "sweep" },
    ],
    approved: ["src/a.ts", "docs/api.md", "pnpm-lock.yaml"],
  });
  await withServer(record, async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(
      endedHelp(output),
      "The reviewer ended this review; verdict: signed-off; some approvals were swept as bulk" +
        " the review never asked anyone to read",
    );
    assert.deepEqual(output.approval, {
      verdict: "signed-off",
      approved: 3,
      unapproved: 0,
      swept: 2,
      total: 3,
    });
    // The counts are the whole payload; the paths behind them are one command away.
    assert.ok(
      (output.help as string[]).some((line) =>
        line.startsWith(`Run \`lightspeed approvals ${BRANCH} ${BASE}\` to name the files`),
      ),
    );
  });
});

test("a review ended with nothing approved never claims the changes are approved", async () => {
  const record = session({
    status: "ended",
    endedBy: "reviewer",
    groups: groups("src/a.ts", "src/b.ts"),
  });
  await withServer(record, async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(endedHelp(output), "The reviewer ended this review; verdict: none");
    assert.deepEqual(output.approval, {
      verdict: "none",
      approved: 0,
      unapproved: 2,
      swept: 0,
      total: 2,
    });
  });
});

test("a part-approved review is reported as partial, without the words repeating it", async () => {
  const record = session({
    status: "ended",
    endedBy: "reviewer",
    groups: groups("src/a.ts", "src/b.ts", "src/c.ts"),
    approved: ["src/b.ts"],
  });
  await withServer(record, async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(endedHelp(output), "The reviewer ended this review; verdict: partial");
    assert.deepEqual(output.approval, {
      verdict: "partial",
      approved: 1,
      unapproved: 2,
      swept: 0,
      total: 3,
    });
  });
});

test("an agent's own `end` is not reported as the reviewer ending the review", async () => {
  const record = session({ status: "ended", endedBy: "agent", groups: groups("src/a.ts") });
  await withServer(record, async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(
      endedHelp(output),
      "`lightspeed end` closed this review, not the reviewer; verdict: none",
    );
    assert.equal((output.approval as { verdict: string }).verdict, "none");
  });
});

test("a session ended before the closer was recorded names neither party", async () => {
  const record = session({ status: "ended", groups: groups("src/a.ts"), approved: ["src/a.ts"] });
  await withServer(record, async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(endedHelp(output), "This review is ended; verdict: signed-off");
    assert.equal((output.approval as { verdict: string }).verdict, "signed-off");
  });
});

/**
 * A server answering one fixed payload, for the shapes a payload can arrive in.
 * It states this CLI's own version: version skew is refused by the handshake, so
 * what is left to read defensively is a payload of the right version that does
 * not hold together.
 */
async function fixedPayloadServer(payload: unknown): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    const body = request.url === "/health" ? { status: "ok", version: CLI_VERSION } : payload;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("an approval written as paths, before the counts, is reported as unreadable", async () => {
  // A server older than the counts sends the file lists that used to be there.
  // Read as counts they would say "approved" off an array's truthiness, so the
  // account is dropped and stated as not reported, which is what it is.
  const legacy = await fixedPayloadServer({
    status: "ended",
    ended: true,
    prompts: [],
    endedBy: "reviewer",
    approval: { approved: ["src/a.ts"], unapproved: [], total: 1 },
  });
  try {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

    assert.equal(
      endedHelp(output),
      "The reviewer ended this review; what was approved was not reported",
    );
    assert.equal("approval" in output, false);
    assert.ok((output.help as string[]).every((line) => !line.includes("lightspeed approvals")));
  } finally {
    await legacy.close();
  }
});

test("counts without the verdict they summarise are reported as unreadable too", async () => {
  // A server from between the two changes: the numbers are right, but the field
  // an agent is told to branch on is missing, and half an account read as a
  // whole one is how an absent verdict becomes "not signed off" by accident.
  const legacy = await fixedPayloadServer({
    status: "ended",
    ended: true,
    prompts: [],
    endedBy: "reviewer",
    approval: { approved: 1, unapproved: 0, swept: 0, total: 1 },
  });
  try {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

    assert.equal(
      endedHelp(output),
      "The reviewer ended this review; what was approved was not reported",
    );
    assert.equal("approval" in output, false);
  } finally {
    await legacy.close();
  }
});

test("a verdict this CLI has never heard of is unreadable, not a sign-off", async () => {
  const legacy = await fixedPayloadServer({
    status: "ended",
    ended: true,
    prompts: [],
    approval: { verdict: "rubber-stamped", approved: 1, unapproved: 0, swept: 0, total: 1 },
  });
  try {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

    assert.equal(endedHelp(output), "This review is ended; what was approved was not reported");
    assert.equal("approval" in output, false);
  } finally {
    await legacy.close();
  }
});

test("a payload written before approvals were carried waits without claiming anything", async () => {
  const legacy = await fixedPayloadServer({ status: "ended", ended: true, prompts: [] });
  try {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

    assert.equal(output.ended, true);
    assert.equal(endedHelp(output), "This review is ended; what was approved was not reported");
    assert.equal("approval" in output, false);
    assert.equal("endedBy" in output, false);
    // An older server states no turn either, and absent must not read as the reviewer's.
    assert.equal("turn" in output, false);
    assert.equal("round" in output, false);
  } finally {
    await legacy.close();
  }
});

test("an ended review with no files says so instead of counting nothing as approval", async () => {
  await withServer(session({ status: "ended", endedBy: "reviewer" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(endedHelp(output), "The reviewer ended this review; verdict: empty");
    assert.deepEqual(output.approval, {
      verdict: "empty",
      approved: 0,
      unapproved: 0,
      swept: 0,
      total: 0,
    });
    // Nothing to name, so nothing points at the command that names things.
    assert.ok((output.help as string[]).every((line) => !line.includes("lightspeed approvals")));
  });
});

test("an ended wait with nothing queued states the silence instead of an empty list", async () => {
  const record = session({
    status: "ended",
    endedBy: "reviewer",
    groups: groups("src/a.ts"),
    approved: ["src/a.ts"],
  });
  await withServer(record, async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.prompts, 0);
    assert.equal(output.message, "no feedback was queued when this review ended");
    // The account and the words it ends on are untouched by the empty list.
    assert.equal(endedHelp(output), "The reviewer ended this review; verdict: signed-off");
    assert.equal((output.approval as { verdict: string }).verdict, "signed-off");
    assert.equal(output.endedBy, "reviewer");
  });
});

test("a wait that carries prompts spends no words saying it is not empty", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal((output.prompts as unknown[]).length, 1);
    assert.equal("message" in output, false);
  });
});

test("annotation ids survive into the wait output, so an answer can be pinned to one", async () => {
  const stamped = { ...annotation, id: "evt_0abc123de_0007" };
  await withServer(session({ pending: [stamped], status: "feedback" }), async ({ port }) => {
    const output = await runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.deepEqual(output.prompts, [stamped]);
  });
});

test("an unknown session fails with session_not_found instead of blocking", async () => {
  await withServer(undefined, async ({ port }) => {
    await assert.rejects(
      () => runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_not_found");
        return true;
      },
    );
  });
});

/**
 * Waits until the server says an agent is parked on this session. The wait is sent from here and
 * registered over there, so a test that paused a fixed moment instead was — on a machine busy
 * enough — stopping the server before the poll had arrived, and testing a poll that met a closed
 * port rather than one the shutdown had to release. Presence is the server's own answer to "is
 * anybody waiting", and every watcher is handed it on connecting, so a poll that parked before
 * this call is seen as readily as one that parks after.
 */
async function untilParked(port: number, key: string): Promise<void> {
  const abort = new AbortController();
  // Wide enough that a machine slow enough to be swapping still gets its poll registered inside
  // it, and finite so a poll that never parks fails the test instead of hanging the run.
  const deadline = setTimeout(() => abort.abort(), 30_000);
  try {
    const events = await fetch(`http://127.0.0.1:${port}/api/session/${key}/events`, {
      signal: abort.signal,
    });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes('"waiting":true')) {
      const { done, value } = await reader.read();
      assert.ok(!done, "the stream ended before the server said an agent was waiting");
      seen += decoder.decode(value);
    }
    await reader.cancel();
  } finally {
    clearTimeout(deadline);
  }
}

test("a server that stops mid-wait is reported instead of failing to parse nothing", async () => {
  await withServer(session(), async ({ port, server }) => {
    const waiting = runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port });
    await untilParked(port, sessionKey(REPO, BRANCH, BASE));
    await server.stop();

    await assert.rejects(
      () => waiting,
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "server_not_running");
        // The 503 the shutdown sends a parked poll, not the refused port a poll that arrived too
        // late would find: both are `server_not_running`, and only this one is the wait ending.
        assert.match(error.message, /shut down while the command was waiting/);
        return true;
      },
    );
  });
});

test("a server that is not running is reported as server_not_running", async () => {
  // Port 1 is privileged and never listening in the test environment.
  await assert.rejects(
    () => runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_not_running");
      return true;
    },
  );
});

/** The mirror of `work` without the turn: a wait made from mid-edit is refused. */
test("waiting while still working is refused with the moves that give the turn up", async () => {
  const record = session({
    status: "feedback",
    turn: { holder: "agent", mode: "working", at: "2025-01-01T00:01:00.000Z", note: "splitting" },
  });
  await withServer(record, async ({ port }) => {
    await assert.rejects(
      () => runWait({ repoRoot: REPO, branch: BRANCH, base: BASE, port }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "turn_still_yours");
        assert.match(error.suggestions.join("\n"), /lightspeed start feature-auth main --wait/);
        return true;
      },
    );
  });
});
