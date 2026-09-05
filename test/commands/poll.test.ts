import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePollArgs, runPoll } from "../../src/commands/poll.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
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

function endedHelp(output: Awaited<ReturnType<typeof runPoll>>): string {
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

async function withServer(
  record: SessionRecord | undefined,
  body: (context: { port: number; store: SessionStore; server: ReviewServer }) => Promise<void>,
): Promise<void> {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-poll-")));
  if (record) store.save(record);
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store, server });
  } finally {
    await server.stop();
  }
}

test("parses branch, base and the agent reply flag", () => {
  assert.deepEqual(parsePollArgs(["feature-auth", "develop", "--agent-reply", "fixed it"]), {
    branch: "feature-auth",
    base: "develop",
    agentReply: "fixed it",
    full: false,
    declarations: [],
  });
});

test("leaves branch and base unset so the session can be resolved from the repository", () => {
  assert.deepEqual(parsePollArgs([]), {
    branch: undefined,
    base: undefined,
    agentReply: undefined,
    full: false,
    declarations: [],
  });
});

test("--for gathers the note and files that follow it, per comment", () => {
  const args = parsePollArgs([
    "feature-auth",
    "--agent-reply",
    "addressed all",
    "--for",
    "evt_a",
    "--note",
    "now one transaction",
    "--files",
    "src/a.ts, src/b.ts",
    "--for",
    "evt_b",
    "--note",
    "intentional",
  ]);

  assert.deepEqual(args.declarations, [
    { id: "evt_a", note: "now one transaction", files: ["src/a.ts", "src/b.ts"] },
    { id: "evt_b", note: "intentional", files: [] },
  ]);
});

function rejectsArgs(args: string[], pattern: RegExp): void {
  assert.throws(
    () => parsePollArgs(args),
    (error: unknown) => {
      assert.match((error as Error).message, pattern);
      return true;
    },
    args.join(" "),
  );
}

test("an unknown flag fails loud instead of being read as a branch name", () => {
  rejectsArgs(["--agent-repl", "typo"], /unknown flag --agent-repl/);
});

test("a declaration must ride a reply", () => {
  rejectsArgs(["--for", "evt_a", "--note", "fixed"], /--for needs --agent-reply/);
});

test("--note and --files before any --for have nothing to describe", () => {
  rejectsArgs(["--agent-reply", "done", "--note", "fixed"], /--note comes after the --for/);
  rejectsArgs(["--agent-reply", "done", "--files", "a.ts"], /--files comes after the --for/);
});

test("a --for that declares nothing is a mistake, not an empty declaration", () => {
  rejectsArgs(["--agent-reply", "done", "--for", "evt_a"], /--for evt_a declares nothing/);
});

test("the same comment declared twice in one command is ambiguous, so it fails", () => {
  rejectsArgs(
    ["--agent-reply", "done", "--for", "evt_a", "--note", "x", "--for", "evt_a", "--note", "y"],
    /--for evt_a was given twice/,
  );
});

test("a flag missing its value is named, not swallowed", () => {
  rejectsArgs(["--agent-reply"], /--agent-reply needs a value/);
  rejectsArgs(["--agent-reply", "done", "--for"], /--for needs a value/);
  rejectsArgs(["--agent-reply", "done", "--for", "evt_a", "--files", ","], /--files needs a/);
});

test("a value that starts with a dash is still a value", () => {
  const args = parsePollArgs([
    "--agent-reply",
    "-1 overall, see notes",
    "--for",
    "evt_a",
    "--note",
    "-1 on that; kept the guard",
  ]);

  assert.equal(args.agentReply, "-1 overall, see notes");
  assert.deepEqual(args.declarations, [
    { id: "evt_a", note: "-1 on that; kept the guard", files: [] },
  ]);
});

test("a --note or --files said twice for one --for fails instead of overwriting", () => {
  rejectsArgs(
    ["--agent-reply", "done", "--for", "evt_a", "--note", "one", "--note", "two"],
    /--note was given twice for --for evt_a/,
  );
  rejectsArgs(
    ["--agent-reply", "done", "--for", "evt_a", "--files", "a.ts", "--files", "b.ts"],
    /--files was given twice for --for evt_a/,
  );
});

test("returns the queued prompts once the reviewer sends", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.status, "feedback");
    assert.equal(output.ended, false);
    assert.deepEqual(output.prompts, [annotation]);
    assert.ok((output.help as string[]).some((line) => line.includes("poll feature-auth main")));
  });
});

test("a huge selection is truncated with a hint at how to see all of it", async () => {
  const huge = { ...annotation, selected_text: "+".repeat(5000) };
  await withServer(session({ pending: [huge], status: "feedback" }), async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    const [prompt] = output.prompts as [{ selected_text: string }];
    assert.ok(prompt.selected_text.length < huge.selected_text.length);
    assert.match(prompt.selected_text, /\(truncated, 5000 chars — use --full\)$/);
  });
});

test("--full hands back the selection exactly as the reviewer made it", async () => {
  const huge = { ...annotation, selected_text: "+".repeat(5000) };
  await withServer(session({ pending: [huge], status: "feedback" }), async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port, full: true });

    assert.deepEqual(output.prompts, [huge]);
  });
});

test("--full is read off the command line", () => {
  assert.deepEqual(parsePollArgs(["feature-auth", "--full"]), {
    branch: "feature-auth",
    base: undefined,
    agentReply: undefined,
    full: true,
    declarations: [],
  });
});

test("an ended review reports it and stops suggesting another poll", async () => {
  await withServer(session({ status: "ended" }), async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.ended, true);
    assert.equal(output.prompts, 0);
    assert.ok((output.help as string[]).every((line) => !line.includes("poll feature-auth")));
    assert.ok((output.help as string[]).some((line) => /only the reviewer reopens/i.test(line)));
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
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(endedHelp(output), "This review is ended; verdict: signed-off");
    assert.equal((output.approval as { verdict: string }).verdict, "signed-off");
  });
});

/** A server from before the ended payload carried what was approved. */
async function legacyPollServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const body = request.url === "/health" ? {} : { status: "ended", ended: true, prompts: [] };
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
  const server: Server = createServer((request, response) => {
    const body =
      request.url === "/health"
        ? {}
        : {
            status: "ended",
            ended: true,
            prompts: [],
            endedBy: "reviewer",
            approval: { approved: ["src/a.ts"], unapproved: [], total: 1 },
          };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(
      endedHelp(output),
      "The reviewer ended this review; what was approved was not reported",
    );
    assert.equal("approval" in output, false);
    assert.ok((output.help as string[]).every((line) => !line.includes("lightspeed approvals")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("counts without the verdict they summarise are reported as unreadable too", async () => {
  // A server from between the two changes: the numbers are right, but the field
  // an agent is told to branch on is missing, and half an account read as a
  // whole one is how an absent verdict becomes "not signed off" by accident.
  const server: Server = createServer((request, response) => {
    const body =
      request.url === "/health"
        ? {}
        : {
            status: "ended",
            ended: true,
            prompts: [],
            endedBy: "reviewer",
            approval: { approved: 1, unapproved: 0, swept: 0, total: 1 },
          };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(
      endedHelp(output),
      "The reviewer ended this review; what was approved was not reported",
    );
    assert.equal("approval" in output, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a payload written before approvals were carried polls without claiming anything", async () => {
  const legacy = await legacyPollServer();
  try {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port: legacy.port });

    assert.equal(output.ended, true);
    assert.equal(endedHelp(output), "This review is ended; what was approved was not reported");
    assert.equal("approval" in output, false);
    assert.equal("endedBy" in output, false);
  } finally {
    await legacy.close();
  }
});

test("an ended review with no files says so instead of counting nothing as approval", async () => {
  await withServer(session({ status: "ended", endedBy: "reviewer" }), async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

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

test("an ended poll with nothing queued states the silence instead of an empty list", async () => {
  const record = session({
    status: "ended",
    endedBy: "reviewer",
    groups: groups("src/a.ts"),
    approved: ["src/a.ts"],
  });
  await withServer(record, async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal(output.prompts, 0);
    assert.equal(output.message, "no feedback was queued when this review ended");
    // The account and the words it ends on are untouched by the empty list.
    assert.equal(endedHelp(output), "The reviewer ended this review; verdict: signed-off");
    assert.equal((output.approval as { verdict: string }).verdict, "signed-off");
    assert.equal(output.endedBy, "reviewer");
  });
});

test("a poll that carries prompts spends no words saying it is not empty", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.equal((output.prompts as unknown[]).length, 1);
    assert.equal("message" in output, false);
  });
});

test("an agent reply is delivered to the reviewer before waiting again", async () => {
  await withServer(
    session({ pending: [annotation], status: "feedback" }),
    async ({ port, store }) => {
      await runPoll({
        repoRoot: REPO,
        branch: BRANCH,
        base: BASE,
        port,
        agentReply: "wrapped it in a transaction",
      });

      const entry = store.get(sessionKey(REPO, BRANCH, BASE))?.conversation.at(-1);
      assert.equal(entry?.role, "agent");
      assert.deepEqual(entry?.prompts, [
        { type: "message", comment: "wrapped it in a transaction" },
      ]);
    },
  );
});

test("annotation ids survive into the poll output, with the hint to declare", async () => {
  const stamped = { ...annotation, id: "evt_0abc123de_0007" };
  await withServer(session({ pending: [stamped], status: "feedback" }), async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.deepEqual(output.prompts, [stamped]);
    assert.ok((output.help as string[]).some((line) => line.includes("--for <id>")));
  });
});

test("prompts without ids earn no declaration hint there is no id to follow", async () => {
  await withServer(session({ pending: [annotation], status: "feedback" }), async ({ port }) => {
    const output = await runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });

    assert.ok((output.help as string[]).every((line) => !line.includes("--for")));
  });
});

/** A session whose reviewer comment already carries its minted id. */
function declarable(id: string): SessionRecord {
  const stamped = { ...annotation, id };
  return session({
    status: "feedback",
    pending: [stamped],
    conversation: [
      { role: "reviewer", at: "2025-01-01T00:00:00.000Z", roundIndex: 0, prompts: [stamped] },
    ],
    rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z", files: [], approvedAtEnd: [] }],
  });
}

test("declarations ride the reply and land on the session, keyed by comment id", async () => {
  await withServer(declarable("evt_a"), async ({ port, store }) => {
    await runPoll({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      port,
      agentReply: "wrapped it in a transaction",
      declarations: [{ id: "evt_a", note: "one transaction now", files: ["src/api/users.ts"] }],
    });

    const stored = store.get(sessionKey(REPO, BRANCH, BASE))?.declarations;
    assert.partialDeepStrictEqual(stored, {
      evt_a: { note: "one transaction now", files: ["src/api/users.ts"] },
    });
  });
});

test("a declaration the server rejects surfaces as declaration_invalid, before any wait", async () => {
  await withServer(declarable("evt_a"), async ({ port, store }) => {
    await assert.rejects(
      () =>
        runPoll({
          repoRoot: REPO,
          branch: BRANCH,
          base: BASE,
          port,
          agentReply: "done",
          declarations: [{ id: "evt_nope", note: "fixed", files: [] }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "declaration_invalid");
        assert.match(error.detail ?? "", /evt_nope/);
        return true;
      },
    );
    // Rejected whole: the reply was not delivered either.
    assert.deepEqual(store.get(sessionKey(REPO, BRANCH, BASE))?.conversation.length, 1);
  });
});

test("an unknown session fails with session_not_found instead of blocking", async () => {
  await withServer(undefined, async ({ port }) => {
    await assert.rejects(
      () => runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port }),
      (error: unknown) => {
        assert.ok(error instanceof ReviewError);
        assert.equal(error.code, "session_not_found");
        return true;
      },
    );
  });
});

/**
 * Waits until the server says an agent is parked on this session. The poll is sent from here and
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

test("a server that stops mid-poll is reported instead of failing to parse nothing", async () => {
  await withServer(session(), async ({ port, server }) => {
    const polling = runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port });
    await untilParked(port, sessionKey(REPO, BRANCH, BASE));
    await server.stop();

    await assert.rejects(
      () => polling,
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
    () => runPoll({ repoRoot: REPO, branch: BRANCH, base: BASE, port: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_not_running");
      return true;
    },
  );
});
