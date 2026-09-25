import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePublishArgs } from "../../src/commands/publish.ts";
import { parseReplyArgs, runReply } from "../../src/commands/reply.ts";
import { runWork } from "../../src/commands/work.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import type { SessionRecord } from "../../src/session-types.ts";
import { threadsOf } from "../../src/threads.ts";
import { renderToon, type StructuredOutput } from "../../src/output.ts";

const BRANCH = "feature-auth";
const BASE = "main";
const AT = "2025-01-01T00:00:00.000Z";
const LISTENED: StructuredOutput = { listened: true };

const annotation = {
  type: "annotation" as const,
  id: "t1",
  file: "src/api/users.ts",
  group: "API Handlers",
  selected_text: "+const user = 1;",
  comment: "why not a transaction?",
};

/** A real repository: a reply from working is measured against its branch tip. */
function repository(): { repoRoot: string; head: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), "lsr-reply-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  git("init", "-q", "-b", BRANCH);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  writeFileSync(join(repoRoot, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "one");
  return { repoRoot, head: git("rev-parse", "HEAD") };
}

function session(repoRoot: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: sessionKey(repoRoot, BRANCH, BASE),
    repoRoot,
    branch: BRANCH,
    base: BASE,
    status: "feedback",
    turn: { holder: "agent", mode: "digesting", at: AT },
    createdAt: AT,
    updatedAt: AT,
    groups: [],
    conversation: [{ role: "reviewer", at: AT, prompts: [annotation], roundIndex: 0 }],
    pending: [],
    approved: [],
    rounds: [{ index: 0, at: AT, files: [], approvedAtEnd: [] }],
    ...overrides,
  };
}

async function withServer(
  record: (repoRoot: string, head: string) => SessionRecord,
  body: (context: {
    port: number;
    store: SessionStore;
    repoRoot: string;
    key: string;
  }) => Promise<void>,
): Promise<void> {
  const { repoRoot, head } = repository();
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-reply-")));
  store.save(record(repoRoot, head));
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    await body({ port, store, repoRoot, key: sessionKey(repoRoot, BRANCH, BASE) });
  } finally {
    await server.stop();
  }
}

function reply(
  port: number,
  repoRoot: string,
  notes: { to: string; text: string }[],
  announced: StructuredOutput[] = [],
) {
  return runReply({
    repoRoot,
    branch: BRANCH,
    base: BASE,
    port,
    notes,
    announce: (block) => void announced.push(block),
    listen: async () => LISTENED,
  });
}

async function refused(promise: Promise<unknown>): Promise<ReviewError> {
  try {
    await promise;
  } catch (thrown) {
    assert.ok(thrown instanceof ReviewError, String(thrown));
    return thrown;
  }
  return assert.fail("expected a refusal");
}

test("every --to pair is read in order, wherever the branch sits", () => {
  assert.deepEqual(
    parseReplyArgs(["--to", "t1", "yes", "feature-auth", "--to", "main", "and one more", "main"]),
    {
      notes: [
        { to: "t1", text: "yes" },
        { to: "main", text: "and one more" },
      ],
      branch: "feature-auth",
      base: "main",
    },
  );
});

/** D1: a reply with nothing to say is not a reply. */
test("a reply with no --to is refused, naming work as the other way out", () => {
  assert.throws(
    () => parseReplyArgs(["feature-auth"]),
    (error: unknown) => {
      assert.match((error as Error).message, /reply needs at least one --to/);
      assert.match((error as { suggestions: string[] }).suggestions.join(" "), /lightspeed work/);
      return true;
    },
  );
});

test("a --to missing its text is refused rather than posting the next flag", () => {
  assert.throws(() => parseReplyArgs(["--to", "t1"]), /--to needs an item id and the text/);
  assert.throws(() => parseReplyArgs(["--to", "--to", "t1", "x"]), /--to needs an item id/);
  assert.throws(() => parseReplyArgs(["--to", "t1", "  "]), /--to needs an item id/);
});

test("a --to whose text is the next flag is refused, not posted as words", () => {
  assert.throws(
    () => parseReplyArgs(["--to", "t1", "--to", "t2", "x"]),
    /--to t1 has no text: the next word is the flag --to/,
  );
  assert.throws(
    () => parsePublishArgs(["--to", "t2", "--intent", "renamed"]),
    /--to t2 has no text: the next word is the flag --intent/,
  );
});

test("unquoted words after --to are refused rather than read as a branch and base", () => {
  assert.throws(
    () => parseReplyArgs(["--to", "t1", "it", "retries", "three", "times"]),
    /more than a branch and a base/,
  );
  assert.throws(
    () => parsePublishArgs(["--intent", "x", "--to", "t1", "done:", "renamed", "a", "b"]),
    /more than a branch and a base/,
  );
});

test("an unknown flag is refused", () => {
  assert.throws(() => parseReplyArgs(["--to", "t1", "x", "--wait"]), /unknown flag --wait/);
});

test("a reply lands in its thread, hands the turn back and waits", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, store, repoRoot, key }) => {
      const output = await reply(port, repoRoot, [{ to: "t1", text: "it is one already" }]);

      assert.equal(output, LISTENED);
      const stored = store.get(key)!;
      assert.equal(stored.turn.holder, "reviewer");
      const [thread] = threadsOf(stored.conversation);
      assert.deepEqual(
        thread?.messages.map((message) => [message.role, message.comment]),
        [
          ["reviewer", "why not a transaction?"],
          ["agent", "it is one already"],
        ],
      );
      assert.equal(stored.lastHandback?.verb, "reply");
    },
  );
});

/** Killed mid-wait, re-run: the same words are not said twice. */
test("a re-run reply posts nothing twice", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, store, repoRoot, key }) => {
      const notes = [{ to: "t1", text: "it is one already" }];
      await reply(port, repoRoot, notes);

      const again = await reply(port, repoRoot, notes);

      assert.equal(again, LISTENED);
      const agentSaid = store.get(key)!.conversation.filter((entry) => entry.role === "agent");
      assert.equal(agentSaid.length, 1);
    },
  );
});

/**
 * The wait may outlive the agent's shell: what landed, and the one command that
 * recovers a killed wait, are on screen before it begins.
 */
test("before it waits, a reply says what landed and the exact command that recovers a kill", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, repoRoot }) => {
      const announced: StructuredOutput[] = [];
      const notes = [
        { to: "t1", text: "it is one already" },
        { to: "main", text: "all else clear" },
      ];
      await reply(port, repoRoot, notes, announced);

      const [shown] = announced;
      assert.equal(shown?.turn, "reviewer");
      assert.deepEqual(shown?.replied, ["t1", "main"]);
      assert.equal("rerun" in shown!, false);
      assert.equal(Object.keys(shown!).at(-1), "next");
      assert.match(
        (shown?.next as { if_killed: string }).if_killed,
        /lightspeed reply --to t1 'it is one already' --to main 'all else clear' feature-auth main$/,
      );
    },
  );
});

/**
 * The printed line is pasted as it reads on screen, TOON escapes and all: an
 * apostrophe cannot be shell-quoted without a backslash or a double quote, and
 * the printer escapes both. The words have landed, so re-attaching recovers the
 * wait just the same, and it quotes nothing.
 */
test("a reply whose text has an apostrophe prints a kill recovery that pastes as shown", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, repoRoot }) => {
      const announced: StructuredOutput[] = [];
      await reply(port, repoRoot, [{ to: "t1", text: "I'll use y" }], announced);

      const printed = renderToon(announced[0]!);
      const line = printed.split("\n").find((one) => one.includes("if_killed"))!;
      assert.doesNotMatch(line.slice(line.indexOf("lightspeed"), -1), /[\\"']/);
      assert.match(line, /: lightspeed open feature-auth main"$/);
    },
  );
});

test("a re-run reply says it landed nothing new before it waits again", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, repoRoot }) => {
      const notes = [{ to: "t1", text: "it is one already" }];
      await reply(port, repoRoot, notes);
      const announced: StructuredOutput[] = [];

      await reply(port, repoRoot, notes, announced);

      assert.equal(announced[0]?.rerun, true);
      assert.equal("replied" in announced[0]!, false);
    },
  );
});

test("a reply to an item that does not exist posts nothing", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, store, repoRoot, key }) => {
      const error = await refused(reply(port, repoRoot, [{ to: "t9", text: "?" }]));

      assert.equal(error.code, "feedback_item_unknown");
      assert.equal(store.get(key)!.turn.holder, "agent");
    },
  );
});

test("a reply while the reviewer holds the turn is refused with the way to listen", async () => {
  await withServer(
    (repoRoot) => session(repoRoot, { turn: { holder: "reviewer", at: AT } }),
    async ({ port, repoRoot }) => {
      const error = await refused(reply(port, repoRoot, [{ to: "t1", text: "early" }]));

      assert.equal(error.code, "turn_not_yours");
      assert.match(error.suggestions.join(" "), /lightspeed open feature-auth main/);
    },
  );
});

/** W2: from working, talk only while nothing has changed since `work`. */
test("a reply from working is legal while the branch and tree are where work found them", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, store, repoRoot, key }) => {
      await work(port, repoRoot);

      await reply(port, repoRoot, [{ to: "t1", text: "one question before I go on" }]);

      assert.equal(store.get(key)!.turn.holder, "reviewer");
    },
  );
});

/** A clean tree is no stand-in for the snapshot: without one, nothing vouches. */
test("a reply from a working turn that recorded no tree is refused, even on a clean tree", async () => {
  await withServer(
    (repoRoot, head) =>
      session(repoRoot, { turn: { holder: "agent", mode: "working", at: AT, note: "p", head } }),
    async ({ port, store, repoRoot, key }) => {
      const error = await refused(reply(port, repoRoot, [{ to: "t1", text: "?" }]));

      assert.equal(error.code, "turn_still_yours");
      assert.match(error.detail ?? "", /no tree was recorded at work/);
      assert.match(error.suggestions.join(" "), /lightspeed publish/);
      assert.equal(store.get(key)!.turn.holder, "agent");
    },
  );
});

test("a reply from working after new commits is refused", async () => {
  await withServer(
    (repoRoot) =>
      session(repoRoot, {
        turn: { holder: "agent", mode: "working", at: AT, note: "p", head: "0".repeat(40) },
      }),
    async ({ port, repoRoot }) => {
      const error = await refused(reply(port, repoRoot, [{ to: "t1", text: "?" }]));

      assert.equal(error.code, "turn_still_yours");
    },
  );
});

function work(port: number, repoRoot: string) {
  return runWork({ repoRoot, branch: BRANCH, base: BASE, port, plan: "the plan" });
}

/**
 * Measured against the tree `work` found, not against a clean one: a stray
 * untracked file there when work began is not half-written code.
 */
test("a reply from working over a tree dirty since before work is legal", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, store, repoRoot, key }) => {
      writeFileSync(join(repoRoot, "notes.txt"), "the agent's scratch\n");
      await work(port, repoRoot);

      await reply(port, repoRoot, [{ to: "t1", text: "one question first" }]);

      assert.equal(store.get(key)!.turn.holder, "reviewer");
    },
  );
});

test("a reply from working after an edit names the tree as what changed", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, repoRoot }) => {
      await work(port, repoRoot);
      writeFileSync(join(repoRoot, "a.txt"), "half-written\n");

      const error = await refused(reply(port, repoRoot, [{ to: "t1", text: "?" }]));

      assert.equal(error.code, "turn_still_yours");
      assert.match(error.detail ?? "", /the working tree changed since work/);
      assert.doesNotMatch(error.detail ?? "", /HEAD/);
      assert.match(error.suggestions.join(" "), /lightspeed publish/);
    },
  );
});

/**
 * The tree is measured by content, not by which paths are dirty: more edits to
 * a file already dirty at `work` are half-written code all the same.
 */
test("a reply from working after more edits to a file already dirty at work is refused", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, store, repoRoot, key }) => {
      writeFileSync(join(repoRoot, "a.txt"), "dirty before work\n");
      await work(port, repoRoot);
      appendFileSync(join(repoRoot, "a.txt"), "and edited after\n");

      const error = await refused(reply(port, repoRoot, [{ to: "t1", text: "?" }]));

      assert.equal(error.code, "turn_still_yours");
      assert.match(error.detail ?? "", /the working tree changed since work/);
      assert.equal(store.get(key)!.turn.holder, "agent");
    },
  );
});

test("a reply from working after an untracked file present at work was rewritten is refused", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, repoRoot }) => {
      writeFileSync(join(repoRoot, "draft.ts"), "export const a = 1;\n");
      await work(port, repoRoot);
      writeFileSync(join(repoRoot, "draft.ts"), "export const a = 2;\n");

      const error = await refused(reply(port, repoRoot, [{ to: "t1", text: "?" }]));

      assert.match(error.detail ?? "", /the working tree changed since work/);
    },
  );
});

test("a reply from working after a commit names HEAD as what moved", async () => {
  await withServer(
    (repoRoot) => session(repoRoot),
    async ({ port, repoRoot }) => {
      await work(port, repoRoot);
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "two"], { cwd: repoRoot });

      const error = await refused(reply(port, repoRoot, [{ to: "t1", text: "?" }]));

      assert.match(error.detail ?? "", /HEAD moved since work/);
    },
  );
});

test("a reply from a working turn that recorded no HEAD says so", async () => {
  await withServer(
    (repoRoot) =>
      session(repoRoot, { turn: { holder: "agent", mode: "working", at: AT, note: "p" } }),
    async ({ port, repoRoot }) => {
      const error = await refused(reply(port, repoRoot, [{ to: "t1", text: "?" }]));

      assert.match(error.detail ?? "", /no HEAD was recorded at work/);
    },
  );
});
