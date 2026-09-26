import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextRule } from "../../src/turn-help.ts";
import { batchOutput, itemRow, listen } from "../../src/commands/listen.ts";
import { ReviewError } from "../../src/errors.ts";
import { renderToon, SELECTION_LIMIT } from "../../src/output.ts";
import { sessionKey } from "../../src/paths.ts";
import { CLI_VERSION } from "../../src/version.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import type { SessionRecord } from "../../src/session-types.ts";
import type { DiffGroup } from "../../src/diff-extract.ts";

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

function endedHelp(output: Awaited<ReturnType<typeof listen>>): string {
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
  id: "t1",
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

/** Ours by `/health`, speaking a protocol this CLI no longer reads. */
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
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-listen-")));
  if (record) store.save(record);
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store, server });
  } finally {
    await server.stop();
  }
}

test("returns the batch as one item per thread once the reviewer sends", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal("ended" in output, false);
    assert.deepEqual(output.items, [
      {
        id: "t1",
        status: "new",
        at: "src/api/users.ts",
        selected: "+const user = 1;",
        reviewer: "wrap in a transaction",
      },
    ]);
  });
});

/**
 * `status` restated what `turn` and `ended` already say, and said it out of
 * date — a session reads `feedback` for rounds after the feedback was consumed.
 */
test("the answer states the turn, not a second stale word for it", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.turn, "agent digesting");
    assert.ok(!("status" in output));
  });
});

/** D5: `round` and `turn` lead, the items follow, and `next:` closes. */
test("a delivered batch leads with round and turn and closes with next", async () => {
  const record = session({
    pending: [annotation],
    status: "feedback",
    rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z", files: [], approvedAtEnd: [] }],
  });
  await withServer(record, async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.turn, "agent digesting");
    assert.equal(output.round, 1);
    assert.deepEqual(Object.keys(output), ["round", "turn", "items", "next"]);
  });
});

/** The handover id is transport: the agent acts on the items, never on it. */
test("the delivery id the client acknowledges is never printed to the agent", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal("delivery" in output, false);
  });
});

/**
 * The decision rule, not a menu: talk or work, keyed on what the agent decided,
 * with the reply line naming the items it holds.
 */
test("a delivered batch closes with the decision rule for this turn", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.deepEqual(output.next, nextRule("agent digesting", "feature-auth main", ["t1"]));
    assert.match((output.next as { talk: string }).talk, /--to t1 '<answer>'/);
  });
});

/**
 * Regression: the guard sat at 2000 characters, so a 1226-character selection
 * came back whole — 372 tokens for one item, of text the agent can read in the
 * file it is standing in.
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
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    const [item] = output.items as [{ selected: string }];
    // The cut itself, not merely "shorter": one character off would satisfy that.
    assert.equal(
      item.selected,
      `${huge.selected_text.slice(0, SELECTION_LIMIT)}\n(truncated, 1226 chars; a.txt:1 has the rest)`,
    );
  });
});

/** The comment is the reviewer's own words, and the only part of an item the
 * agent cannot read anywhere else — so no cap and no `--full`. */
test("the reviewer's comment comes back whole however long it is", async () => {
  const wordy = { ...annotation, comment: "because ".repeat(400) };
  const many = Array.from({ length: 30 }, (_, index) => ({ ...wordy, id: `t${index + 1}` }));
  await withServer(session({ pending: many, status: "feedback" }), async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    const items = output.items as { reviewer: string }[];
    assert.equal(items.length, 30);
    assert.equal(items[0]?.reviewer, wordy.comment);
  });
});

test("an item row names the place, the thread so far and every new reviewer message", () => {
  assert.deepEqual(
    itemRow({
      id: "t2",
      status: "reply",
      file: "src/a.ts",
      side: "old",
      line_start: 3,
      line_end: 5,
      thread: [
        { who: "reviewer", said: "why cache?" },
        { who: "you", said: "it is cached upstream" },
      ],
      reviewer: ["where?", "link it"],
    }),
    {
      id: "t2",
      status: "reply",
      at: "src/a.ts:3-5 (base)",
      thread: [
        { who: "reviewer", said: "why cache?" },
        { who: "you", said: "it is cached upstream" },
      ],
      reviewer: ["where?", "link it"],
    },
  );
  // A bare resolve says what it was about, and prints no empty reviewer list.
  assert.deepEqual(itemRow({ id: "t4", status: "resolved", asked: "why 2?", reviewer: [] }), {
    id: "t4",
    status: "resolved",
    asked: "why 2?",
  });
});

test("an anchor whose line changed since its round says so beside the place", () => {
  const row = itemRow({
    id: "t1",
    status: "reply",
    file: "greet.ts",
    side: "new",
    line_start: 5,
    line_end: 5,
    selected_text: "export const shout",
    anchoredIn: 0,
    outdated: true,
    thread: [{ who: "reviewer", said: "rename" }],
    reviewer: ["and the README"],
  });

  assert.deepEqual(Object.keys(row), [
    "id",
    "status",
    "at",
    "outdated",
    "selected",
    "thread",
    "reviewer",
  ]);
  assert.equal(row.outdated, "anchored in round 1; that line has changed since");
  assert.match(renderToon({ items: [row] }), /thread\[1\]\{who,said\}:\n\s+reviewer,rename/);
});

test("a resolved item is not offered as one to reply to", () => {
  const output = batchOutput(
    {
      status: "feedback",
      ended: false,
      turn: "agent digesting",
      round: 2,
      items: [
        { id: "t1", status: "resolved", reviewer: ["thanks"] },
        { id: "t2", status: "new", reviewer: ["and this?"] },
      ],
    },
    "feature-auth main",
  );

  assert.match((output.next as { talk: string }).talk, /--to t2 '<answer>' feature-auth main/);
  assert.doesNotMatch((output.next as { talk: string }).talk, /--to t1/);
});

test("a wait another command took over exits with nothing to do, not with a batch", () => {
  const output = batchOutput(
    {
      status: "open",
      ended: false,
      items: [],
      superseded: true,
      message: "another lightspeed command took over listening for this review; nothing to do here",
    },
    "feature-auth main",
  );

  assert.equal(output.superseded, true);
  assert.match(String(output.message), /another lightspeed command took over listening/);
  assert.equal(output.items, undefined);
  assert.match((output.next as { done: string }).done, /nothing to do/i);
});

/**
 * Regression: a `serve` left over from an older install answered with no `turn`
 * and no `round`, and the client defaulted its way past it. A wait that cannot
 * trust the answer must not block for one.
 */
test("a wait against a server of another version is refused, with the way to clear it", async () => {
  const stale = createStaleServer("0.0.1");
  await new Promise<void>((resolve) => stale.listen(0, "127.0.0.1", resolve));
  const { port } = stale.address() as { port: number };

  await assert.rejects(
    () => listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_stale");
      assert.match(error.message, /0\.0\.1/);
      assert.match(error.suggestions.join(" "), /lightspeed stop/);
      assert.match(error.suggestions.join(" "), /lightspeed open feature-auth main/);
      return true;
    },
  );

  await new Promise<void>((resolve) => stale.close(() => resolve()));
});

test("an ended review reports it and stops suggesting another wait", async () => {
  await withServer(session({ status: "ended" }), async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.ended, true);
    assert.equal(output.turn, "ended");
    assert.equal("items" in output, false);
    // The account, then the one move an ended review leaves — no re-attach,
    // which would return "ended" forever.
    assert.equal((output.help as string[]).length, 1);
    assert.deepEqual(output.next, nextRule("ended", "feature-auth main"));
    assert.match((output.next as { done: string }).done, /--reopen/);
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
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(
      endedHelp(output),
      "`lightspeed end` ended this review, not the reviewer; verdict: none",
    );
    assert.equal((output.approval as { verdict: string }).verdict, "none");
  });
});

test("a session ended before the closer was recorded names neither party", async () => {
  const record = session({ status: "ended", groups: groups("src/a.ts"), approved: ["src/a.ts"] });
  await withServer(record, async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(endedHelp(output), "This review is ended; verdict: signed-off");
    assert.equal((output.approval as { verdict: string }).verdict, "signed-off");
  });
});

/**
 * States this CLI's own version: version skew is refused by the handshake, so
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
  // A server older than the counts sends file lists. Read as counts they would
  // say "approved" off an array's truthiness, so the account is dropped.
  const legacy = await fixedPayloadServer({
    status: "ended",
    ended: true,
    items: [],
    endedBy: "reviewer",
    approval: { approved: ["src/a.ts"], unapproved: [], total: 1 },
  });
  try {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

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
  // an agent is told to branch on is missing, and an absent verdict read as a
  // whole account becomes "not signed off" by accident.
  const legacy = await fixedPayloadServer({
    status: "ended",
    ended: true,
    items: [],
    endedBy: "reviewer",
    approval: { approved: 1, unapproved: 0, swept: 0, total: 1 },
  });
  try {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

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
    items: [],
    approval: { verdict: "rubber-stamped", approved: 1, unapproved: 0, swept: 0, total: 1 },
  });
  try {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

    assert.equal(endedHelp(output), "This review is ended; what was approved was not reported");
    assert.equal("approval" in output, false);
  } finally {
    await legacy.close();
  }
});

test("a payload written before approvals were carried waits without claiming anything", async () => {
  const legacy = await fixedPayloadServer({ status: "ended", ended: true, items: [] });
  try {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

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
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal("items" in output, false);
    assert.equal(output.message, "no feedback was queued when this review ended");
    assert.equal(endedHelp(output), "The reviewer ended this review; verdict: signed-off");
    assert.equal((output.approval as { verdict: string }).verdict, "signed-off");
    assert.equal(output.endedBy, "reviewer");
  });
});

test("a batch that carries items spends no words saying it is not empty", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal((output.items as unknown[]).length, 1);
    assert.equal("message" in output, false);
  });
});

test("item ids survive into the batch, so a reply can be pinned to one", async () => {
  const stamped = { ...annotation, id: "t7" };
  await withServer(session({ pending: [stamped], status: "feedback" }), async ({ port }) => {
    const output = await listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal((output.items as { id: string }[])[0]?.id, "t7");
    assert.match((output.next as { talk: string }).talk, /--to t7/);
  });
});

test("an unknown session fails with session_not_found instead of blocking", async () => {
  await withServer(undefined, async ({ port }) => {
    await assert.rejects(
      () => listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_not_found");
        return true;
      },
    );
  });
});

/**
 * A test that paused a fixed moment instead was — on a machine busy enough — stopping the server
 * before the poll had arrived, and testing a poll that met a closed port rather than one the
 * shutdown had to release. Every watcher is handed presence on connecting, so a poll that parked
 * before this call is seen as readily as one that parks after.
 */
async function untilParked(port: number, key: string): Promise<void> {
  const abort = new AbortController();
  // Wide enough for a swapping machine, finite so a poll that never parks fails the test.
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
    const waiting = listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port });
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
    () => listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_not_running");
      return true;
    },
  );
});

test("listening while still working is refused with the move that give the turn up", async () => {
  const record = session({
    status: "feedback",
    turn: { holder: "agent", mode: "working", at: "2025-01-01T00:01:00.000Z", note: "splitting" },
  });
  await withServer(record, async ({ port }) => {
    await assert.rejects(
      () => listen({ repoRoot: REPO, branch: BRANCH, base: BASE, port }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "turn_still_yours");
        assert.match(error.suggestions.join("\n"), /lightspeed publish feature-auth main --intent/);
        return true;
      },
    );
  });
});
