import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxiError } from "axi-sdk-js";
import type { LightspeedConfig } from "../../src/config.ts";
import type { GroupDiffInput, GroupingMode, GroupingResult } from "../../src/llm/grouping.ts";
import type { DiffFile, ExtractedDiff } from "../../src/diff-extract.ts";
import { parseOpenArgs, runOpen } from "../../src/commands/open.ts";
import { parsePublishArgs, runPublish } from "../../src/commands/publish.ts";
import type { RoundDeps } from "../../src/commands/round.ts";
import { renderToon, type StructuredOutput } from "../../src/output.ts";
import { agentDigesting, agentWorking } from "../../src/turn.ts";
import { launchBrowser } from "../../src/commands/open-browser.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import { LedgerStore } from "../../src/ledger/store.ts";
import { freePort } from "../helpers/ports.ts";
import { git, newRepo } from "../helpers/git-repo.ts";

/** `undefined` stands for `feedbackLog: "off"`; a blocked path for a broken disk. */
function harnessLedger(kind: "on" | "off" | "broken"): LedgerStore | undefined {
  if (kind === "off") return undefined;
  const dir = mkdtempSync(join(tmpdir(), "lsr-open-ledger-"));
  if (kind === "on") return new LedgerStore(join(dir, "feedback"));
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  return new LedgerStore(join(blocker, "feedback"));
}

const REPO = "/repo";
const BRANCH = "feature-auth";
const BASE = "main";
const INTENTS = ["replace session cookies with signed tokens"];

function diffFile(path: string): DiffFile {
  return {
    path,
    status: "modified",
    diff: `index 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    insertions: 1,
    deletions: 1,
    oversized: false,
  };
}

/** Every extraction is a new commit: a publish is only a round on a moved HEAD. */
function extractedAt(round: number): ExtractedDiff {
  return {
    files: [diffFile("src/api/users.ts"), diffFile("src/auth/token.ts")],
    stats: { files_changed: 2, insertions: 2, deletions: 2, binary_skipped: 1 },
    baseCommit: "a".repeat(40),
    headCommit: String(round).repeat(40).slice(0, 40),
    commits: ["sign the tokens"],
  };
}

const LISTENED: StructuredOutput = { listened: true };

interface Harness {
  config: LightspeedConfig;
  deps: RoundDeps;
  /** What each command showed before it began to wait. */
  announced: StructuredOutput[];
  store: SessionStore;
  ledger: LedgerStore | undefined;
  opened: string[];
  grouped: GroupDiffInput[];
  /** The grouping notices, and each seam's turn, in the order they happened. */
  steps: string[];
  notices: StructuredOutput[];
}

/** A real review server on a real port: only the diff and the LLM are faked. */
async function withHarness(
  body: (harness: Harness) => Promise<void>,
  ledgerKind: "on" | "off" | "broken" = "off",
): Promise<void> {
  const port = await freePort();
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-open-"));
  const store = new SessionStore(stateDir);
  const ledger = harnessLedger(ledgerKind);
  const server: ReviewServer = createReviewServer({ store, ledger, port });
  await server.start();
  const opened: string[] = [];
  const config: LightspeedConfig = {
    model: "test/model",
    thinking: "off",
    port,
    stateDir,
    feedbackLog: "off",
    classify: { mechanical: [], guardrail: [] },
  };
  const grouped: GroupDiffInput[] = [];
  const announced: StructuredOutput[] = [];
  const steps: string[] = [];
  const notices: StructuredOutput[] = [];
  let extractions = 0;
  const deps: RoundDeps = {
    extractDiff: () => extractedAt((extractions += 1)),
    announceGrouping: (block) => {
      steps.push("notice");
      notices.push(block);
    },
    groupDiff: async (input) => {
      steps.push("group");
      grouped.push(input);
      return {
        groups: [
          { name: "API Handlers", rationale: "requests", files: input.files.slice(0, 1) },
          { name: "Auth", rationale: "tokens", files: input.files.slice(1) },
        ],
        mode: "llm",
      };
    },
    ensureServerRunning: async () => undefined,
    openBrowser: (url) => opened.push(url),
    announce: (block) => void announced.push(block),
    listen: async () => LISTENED,
  };
  try {
    await body({ config, deps, announced, store, ledger, opened, grouped, steps, notices });
  } finally {
    await server.stop();
  }
}

const KEY = sessionKey(REPO, BRANCH, BASE);
const AT_START = "2025-01-01T00:00:00Z";

function open(harness: Harness, extra: Partial<Parameters<typeof runOpen>[0]> = {}) {
  const { config, deps } = harness;
  return runOpen({
    repoRoot: REPO,
    branch: BRANCH,
    base: BASE,
    intents: INTENTS,
    config,
    deps,
    ...extra,
  });
}

/** The reviewer sent, the agent ran `work`: the only turn a publish ends. */
function toWorking(store: SessionStore): void {
  store.save({ ...store.get(KEY)!, turn: agentWorking(new Date().toISOString(), "the plan") });
}

function publish(harness: Harness, extra: Partial<Parameters<typeof runPublish>[0]> = {}) {
  const { config, deps } = harness;
  return runPublish({
    repoRoot: REPO,
    branch: BRANCH,
    base: BASE,
    intents: INTENTS,
    notes: [],
    config,
    deps,
    ...extra,
  });
}

async function publishNext(
  harness: Harness,
  extra: Partial<Parameters<typeof runPublish>[0]> = {},
): Promise<StructuredOutput> {
  toWorking(harness.store);
  return await publish(harness, extra);
}

function refusal(promise: Promise<unknown>): Promise<ReviewError> {
  return promise.then(
    () => assert.fail("expected a refusal"),
    (thrown: unknown) => {
      assert.ok(thrown instanceof ReviewError, String(thrown));
      return thrown;
    },
  );
}

test("open creates the session, shows the round, then waits for the first Send", async () => {
  await withHarness(async (harness) => {
    const output = await open(harness);

    assert.equal(output, LISTENED);
    const [shown] = harness.announced;
    assert.deepEqual(shown?.session, {
      key: KEY,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      url: `http://127.0.0.1:${harness.config.port}/session/${KEY}`,
    });
    assert.equal(shown?.turn, "reviewer");
    assert.equal(shown?.round, 1);
    assert.deepEqual(shown?.diff, extractedAt(1).stats);
    assert.deepEqual(shown?.groups, [
      { name: "API Handlers", files: 1 },
      { name: "Auth", files: 1 },
    ]);
    assert.match(String(shown?.message), /give the reviewer the url/);
    assert.equal(harness.store.get(KEY)?.groups.length, 2);
  });
});

test("records the commits the diff was taken between, so whole files can be read", async () => {
  await withHarness(async (harness) => {
    await open(harness);

    const record = harness.store.get(KEY);
    assert.equal(record?.baseCommit, extractedAt(1).baseCommit);
    assert.equal(record?.headCommit, extractedAt(1).headCommit);
  });
});

test("reports why grouping was skipped so the agent can see the LLM was not used", async () => {
  await withHarness(async (harness) => {
    await open(harness, {
      deps: {
        ...harness.deps,
        groupDiff: async ({ files }) => ({
          groups: [{ name: "All Changes", rationale: "small diff", files }],
          mode: "skipped",
          reason: "1 changed file: nothing to order",
        }),
      },
    });

    assert.deepEqual(harness.announced[0]?.grouping, {
      mode: "skipped",
      reason: "1 changed file: nothing to order",
    });
  });
});

/** The edit that buys the grouping back rides out with the round that lost it. */
test("a degraded grouping carries the fix beside the reason", async () => {
  await withHarness(async (harness) => {
    await open(harness, {
      deps: {
        ...harness.deps,
        groupDiff: async ({ files }) => ({
          groups: [{ name: "All Changes", rationale: "ungrouped", files }],
          mode: "fallback",
          reason: "unknown model `anthropic/claude-sonnet-4` — the diff is one group",
          fix: "set `model` in .lightspeed.conf.json to a model you can reach",
        }),
      },
    });

    assert.deepEqual(harness.announced[0]?.grouping, {
      mode: "fallback",
      reason: "unknown model `anthropic/claude-sonnet-4` — the diff is one group",
      fix: "set `model` in .lightspeed.conf.json to a model you can reach",
    });
  });
});

test("opens the review page in a browser", async () => {
  await withHarness(async (harness) => {
    await open(harness);

    assert.deepEqual(harness.opened, [(harness.announced[0]?.session as { url: string }).url]);
  });
});

test("--no-open leaves the browser alone", async () => {
  await withHarness(async (harness) => {
    await open(harness, { open: false });

    assert.deepEqual(harness.opened, []);
  });
});

/** D2: a waiting command killed mid-wait is recovered by running it again. */
test("open on a live review re-attaches: no grouping, no round, straight to the wait", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.store.save({
      ...harness.store.get(KEY)!,
      turn: agentDigesting("2025-01-01T00:00:00Z"),
    });

    const output = await open(harness, { intents: [] });

    assert.equal(output, LISTENED);
    assert.equal(harness.grouped.length, 1);
    assert.equal(harness.store.get(KEY)?.rounds.length, 1);
    assert.equal(harness.opened.length, 1);
    const shown = harness.announced[1]!;
    assert.equal(shown.turn, "agent digesting");
    assert.match(String(shown.message), /re-attached/);
  });
});

/** Digesting, open does not wait: it hands the held batch straight back, and says so. */
test("a re-attach says whether it hands back the batch being digested or waits for a Send", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    await open(harness, { intents: [] });
    harness.store.save({
      ...harness.store.get(KEY)!,
      turn: agentDigesting("2025-01-01T00:00:00Z"),
    });
    await open(harness, { intents: [] });

    const [, onReviewers, onDigesting] = harness.announced;
    assert.equal(onReviewers?.turn, "reviewer");
    assert.match(String(onReviewers?.message), /waiting for the reviewer's Send/);
    assert.equal(onDigesting?.turn, "agent digesting");
    assert.match(String(onDigesting?.message), /handing back the batch you are digesting/);
    assert.doesNotMatch(String(onDigesting?.message), /waiting for the reviewer's Send/);
  });
});

/**
 * A kill recovery is for a wait, and handing back a held batch is none: the
 * line read as "this may block", on a command that had already returned.
 */
test("a re-attach that hands back the batch being digested prints no kill recovery", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    await open(harness, { intents: [] });
    harness.store.save({
      ...harness.store.get(KEY)!,
      turn: agentDigesting("2025-01-01T00:00:00Z"),
    });
    await open(harness, { intents: ["ignored"] });

    const [, onReviewers, onDigesting] = harness.announced;
    assert.match(ifKilled(onReviewers), /lightspeed open feature-auth main$/);
    assert.equal(onDigesting?.next, undefined);
    assert.match(String(onDigesting?.message), /re-attached/);
    assert.match(String(onDigesting?.note), /--intent is ignored/);
    assert.equal((onDigesting?.session as { key: string }).key, KEY);
  });
});

function ifKilled(block: StructuredOutput | undefined): string {
  return (block?.next as { if_killed: string }).if_killed;
}

/** Re-attaching needs no --intent, so the recovery line spells none. */
test("before it waits, open names the command that recovers a kill: open, no intent", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    await open(harness, { intents: [] });

    const [fresh, again] = harness.announced;
    assert.match(ifKilled(fresh), /`?lightspeed open feature-auth main`?$/);
    assert.match(ifKilled(again), /`?lightspeed open feature-auth main`?$/);
    assert.equal(Object.keys(fresh!).at(-1), "next");
  });
});

/**
 * Grouping is the one slow step before anything is printed. An agent killed
 * there saw no output at all and no way back, so the notice goes out first,
 * with the command that recovers it.
 */
test("open says it is grouping before the model call, naming the open to re-run", async () => {
  await withHarness(async (harness) => {
    await open(harness, { intents: ["sign the tokens", "drop the cookie"], open: false });

    assert.deepEqual(harness.steps, ["notice", "group"]);
    const [notice] = harness.notices;
    assert.equal(notice?.status, "grouping 2 files — can take minutes");
    assert.match(ifKilled(notice), /Only this command died, and the review is unharmed/);
    assert.match(ifKilled(notice), /never open another review, end or reopen to recover/);
    assert.ok(
      ifKilled(notice).endsWith(
        ": lightspeed open feature-auth main --intent 'sign the tokens' --intent 'drop the cookie' --no-open",
      ),
      ifKilled(notice),
    );
  });
});

test("an --reopen being grouped is re-run with --reopen, or it would be refused as ended", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.store.save({ ...harness.store.get(KEY)!, status: "ended", endedBy: "reviewer" });

    await open(harness, { reopen: true });

    assert.match(ifKilled(harness.notices[1]), /--intent '[^']+' --reopen$/);
  });
});

/** An apostrophe cannot be printed so it pastes as shown; a wrong command would be worse than none. */
test("a grouping notice whose intent will not paste says to re-run the same command unchanged", async () => {
  await withHarness(async (harness) => {
    await open(harness, { intents: ["the user's tokens"] });

    assert.match(
      ifKilled(harness.notices[0]),
      /Re-run the same command, unchanged, with NO timeout parameter/,
    );
    assert.doesNotMatch(ifKilled(harness.notices[0]), /lightspeed open/);
  });
});

test("a one-file diff calls no model, so nothing announces grouping", async () => {
  await withHarness(async (harness) => {
    await open(harness, {
      deps: {
        ...harness.deps,
        extractDiff: () => ({ ...extractedAt(1), files: [diffFile("src/api/users.ts")] }),
      },
    });

    assert.deepEqual(harness.notices, []);
  });
});

test("publish says it is grouping before the model call, naming the publish to re-run", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.steps.length = 0;

    await publishNext(harness, {
      intents: ["retry on 503"],
      notes: [{ to: "main", text: "done" }],
    });

    assert.deepEqual(harness.steps, ["notice", "group"]);
    assert.ok(
      ifKilled(harness.notices[1]).endsWith(
        ": lightspeed publish feature-auth main --intent 'retry on 503' --to main 'done'",
      ),
      ifKilled(harness.notices[1]),
    );
  });
});

/**
 * Another open landed the review while this one was grouping: the server
 * re-attaches instead of opening a second round, and the agent must be told
 * that — "the review is open" would describe a round this command never made.
 */
test("a fresh open the server answers as a re-attach says re-attached and opens no browser", async () => {
  await withHarness(async (harness) => {
    await open(harness, { open: false });
    const landedMeanwhile = harness.store.get(KEY)!;
    harness.store.remove(KEY);

    await open(harness, {
      deps: {
        ...harness.deps,
        ensureServerRunning: async () => harness.store.save(landedMeanwhile),
      },
    });

    const shown = harness.announced[1]!;
    assert.match(
      String(shown.message),
      /^re-attached to the live review; waiting for the reviewer's Send/,
    );
    assert.doesNotMatch(String(shown.message), /the review is open/);
    assert.match(String(shown.note), /--intent is ignored/);
    assert.equal(shown.turn, "reviewer");
    assert.equal(shown.round, 1);
    assert.equal((shown.session as { key: string }).key, KEY);
    assert.match(ifKilled(shown), /: lightspeed open feature-auth main$/);
    assert.equal("groups" in shown, false);
    assert.deepEqual(harness.opened, []);
    assert.equal(harness.store.get(KEY)?.rounds.length, 1);
  });
});

/** A repository with `main`, a `develop` a commit ahead of it, the branch under review, and an `origin` remote tracking main. */
function repoWithRemote(): string {
  const repoRoot = newRepo("lsr-elsewhere-");
  git(repoRoot, "commit", "--allow-empty", "-m", "base");
  git(repoRoot, "remote", "add", "origin", "https://example.invalid/app.git");
  git(repoRoot, "update-ref", "refs/remotes/origin/main", "main");
  git(repoRoot, "branch", "develop");
  git(repoRoot, "commit", "--allow-empty", "-m", "ahead");
  git(repoRoot, "branch", "-f", "develop", "HEAD");
  git(repoRoot, "reset", "--hard", "HEAD~1");
  git(repoRoot, "checkout", "-b", BRANCH);
  git(repoRoot, "commit", "--allow-empty", "-m", "tip");
  return repoRoot;
}

/**
 * Regression: `open feat origin/main` beside a live `feat main` (or the same
 * open from another worktree) silently made a second review, and the agent
 * waited there while the reviewer's Send sat in the first.
 */
test("a fresh open is refused while the branch is live against the same base spelled otherwise", async () => {
  await withHarness(async (harness) => {
    const repoRoot = repoWithRemote();
    await open(harness, { repoRoot, base: "main" });

    for (const base of ["origin/main", "refs/heads/main", "refs/remotes/origin/main"]) {
      const error = await refusal(open(harness, { repoRoot, base }));

      assert.equal(error.code, "live_review_elsewhere", base);
      assert.match(error.message, new RegExp(`${BRANCH} against main is live`));
      assert.match(
        error.suggestions[0]!,
        /^Run `lightspeed open feature-auth main` to re-attach to it/,
      );
    }
    assert.equal(harness.grouped.length, 1);
    assert.equal(harness.store.list().length, 1);
  });
});

test("a remote-tracking base behind its branch still names it, and a second name at one commit is the same base", async () => {
  await withHarness(async (harness) => {
    const repoRoot = repoWithRemote();
    await open(harness, { repoRoot, base: "main" });
    git(repoRoot, "branch", "trunk", "main");
    git(repoRoot, "update-ref", "refs/heads/main", "develop");

    assert.equal(
      (await refusal(open(harness, { repoRoot, base: "origin/main" }))).code,
      "live_review_elsewhere",
    );
    git(repoRoot, "update-ref", "refs/heads/main", "trunk");
    assert.equal(
      (await refusal(open(harness, { repoRoot, base: "trunk" }))).code,
      "live_review_elsewhere",
    );
  });
});

/** The re-run a weak model makes after a kill often drops --intent: it needs its review back, not a reason. */
test("the duplicate is named before a missing --intent, and --reopen is not guarded", async () => {
  await withHarness(async (harness) => {
    const repoRoot = repoWithRemote();
    await open(harness, { repoRoot, base: "main" });

    const error = await refusal(open(harness, { repoRoot, base: "origin/main", intents: [] }));

    assert.equal(error.code, "live_review_elsewhere");
    await open(harness, { repoRoot, base: "origin/main", reopen: true });
    assert.equal(harness.store.list().length, 2);
  });
});

test("a fresh open from another worktree of the repository names the re-attach in the first", async () => {
  await withHarness(async (harness) => {
    const repoRoot = repoWithRemote();
    const worktree = join(mkdtempSync(join(tmpdir(), "lsr-elsewhere-wt-")), "wt");
    git(repoRoot, "worktree", "add", "-b", "scratch", worktree, "main");
    await open(harness, { repoRoot });

    const error = await refusal(open(harness, { repoRoot: worktree }));

    assert.equal(error.code, "live_review_elsewhere");
    assert.match(error.message, new RegExp(`in ${repoRoot}`));
    assert.equal(
      error.suggestions[0]!.split(" to re-attach")[0],
      `Run \`cd ${repoRoot} && lightspeed open feature-auth main\``,
    );
  });
});

test("an ended review, another base, or another repository's branch of the same name does not block an open", async () => {
  await withHarness(async (harness) => {
    const repoRoot = repoWithRemote();
    await open(harness, { repoRoot, base: "develop" });
    await open(harness, { repoRoot: repoWithRemote(), base: "main" });
    const ended = sessionKey(repoRoot, BRANCH, "develop");
    harness.store.save({ ...harness.store.get(ended)!, status: "ended", endedBy: "agent" });

    await open(harness, { repoRoot, base: "origin/main" });

    assert.equal(harness.store.list().length, 3);
  });
});

/** A live `feat main` does not stop `feat develop`: two bases are two diffs, and possibly two reviews on purpose. */
test("the same branch against a base at another commit is a different review", async () => {
  await withHarness(async (harness) => {
    const repoRoot = repoWithRemote();
    await open(harness, { repoRoot, base: "main" });

    await open(harness, { repoRoot, base: "develop" });

    assert.equal(harness.store.list().length, 2);
  });
});

/** Working: nobody will send, so a wait would hang on edits only the agent can finish. */
test("open on a working turn is refused before it announces a wait, naming publish", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    toWorking(harness.store);
    harness.announced.length = 0;

    const error = await refusal(open(harness, { intents: [] }));

    assert.equal(error.code, "turn_still_yours");
    assert.match(error.suggestions.join(" "), /lightspeed publish feature-auth main --intent/);
    assert.equal(harness.announced.length, 0);
  });
});

/** A live review keeps the intents it opened with; one typed now goes nowhere. */
test("an --intent on a live review is said to be ignored, not silently dropped", async () => {
  await withHarness(async (harness) => {
    await open(harness);

    await open(harness, { intents: ["something new"] });

    const shown = harness.announced[1]!;
    assert.match(String(shown.note), /--intent is ignored/);
    assert.match(String(shown.note), /lightspeed publish feature-auth main --intent/);
  });
});

test("a fresh open without --intent is refused before any git or model work", async () => {
  await withHarness(async (harness) => {
    const error = await refusal(open(harness, { intents: [] }));

    assert.equal(error.code, "intent_missing");
    assert.match(error.suggestions.join(" "), /lightspeed open feature-auth main --intent/);
    assert.equal(harness.grouped.length, 0);
    assert.equal(harness.store.get(KEY), undefined);
  });
});

test("publish keeps the conversation and the approvals the diff has not undone", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.store.save({
      ...harness.store.get(KEY)!,
      conversation: [{ role: "reviewer", at: "2025-01-01T00:00:00.000Z", prompts: [] }],
      approved: ["src/api/users.ts"],
    });

    const output = await publishNext(harness);

    assert.equal(output, LISTENED);
    const stored = harness.store.get(KEY)!;
    assert.equal(stored.rounds.length, 2);
    assert.equal(stored.conversation[0]?.role, "reviewer");
    // Same file diff in the new round: the file the reviewer ticked is the file they read.
    assert.deepEqual(stored.approved, ["src/api/users.ts"]);
    assert.equal(stored.turn.holder, "reviewer");
    assert.match(String(harness.announced[1]?.message), /published/);
  });
});

/**
 * Ticked files once fed to the model sank them: what the reviewer ticked stays
 * between the browser and the server.
 */
test("the grouping call carries last round's reading order and no word of approval", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.store.save({ ...harness.store.get(KEY)!, approved: ["src/api/users.ts"] });

    await publishNext(harness);

    const { grouped } = harness;
    assert.equal(grouped.length, 2);
    assert.deepEqual(Object.keys(grouped[0]!).toSorted(), ["config", "files", "intents"]);
    assert.deepEqual(Object.keys(grouped[1]!).toSorted(), [
      "config",
      "files",
      "intents",
      "previous",
    ]);
    assert.deepEqual(grouped[1]?.previous, MODEL_GROUPING);
  });
});

function groupingFor(mode: GroupingMode, files: DiffFile[]): GroupingResult {
  if (mode === "llm") {
    return {
      groups: [
        { name: "API Handlers", rationale: "requests", files: files.slice(0, 1) },
        { name: "Auth", rationale: "tokens", files: files.slice(1) },
      ],
      mode,
    };
  }
  return {
    groups: [{ name: "All Changes", rationale: "not ordered by a model", files }],
    mode,
    reason: "upstream 503",
  };
}

async function rounds(
  harness: Harness,
  modes: GroupingMode[],
): Promise<{ calls: GroupDiffInput[] }> {
  const calls: GroupDiffInput[] = [];
  const deps: RoundDeps = {
    ...harness.deps,
    groupDiff: async (input) => {
      calls.push(input);
      return groupingFor(modes[calls.length - 1] ?? "llm", input.files);
    },
  };
  await open(harness, { deps });
  for (let round = 1; round < modes.length; round += 1) await publishNext(harness, { deps });
  return { calls };
}

const MODEL_GROUPING = [
  { name: "API Handlers", files: ["src/api/users.ts"] },
  { name: "Auth", files: ["src/auth/token.ts"] },
];

/**
 * `fallback`/`skipped` are one catch-all group and hold-previous-order is the prompt's strongest
 * rule: fed back, one degraded round would flatten every round after, so the next starts fresh.
 */
test("a round no model grouped is not handed back as the order the reviewer read", async () => {
  await withHarness(async (harness) => {
    const { calls } = await rounds(harness, ["llm", "fallback", "llm"]);

    assert.equal(calls.length, 3);
    assert.deepEqual(calls[1]?.previous, MODEL_GROUPING);
    assert.equal("previous" in calls[2]!, false);
    assert.deepEqual(
      harness.store.get(KEY)!.rounds.map((round) => round.grouping),
      ["llm", "fallback", "llm"],
    );
  });
});

test("three rounds the model grouped carry the reading order the whole way", async () => {
  await withHarness(async (harness) => {
    const { calls } = await rounds(harness, ["llm", "llm", "llm"]);

    assert.equal("previous" in calls[0]!, false);
    assert.deepEqual(calls[1]?.previous, MODEL_GROUPING);
    assert.deepEqual(calls[2]?.previous, MODEL_GROUPING);
  });
});

/** Pre-field rounds cannot say what they were, and nearly all were the model's. */
test("a round from before the mode was recorded still carries its grouping", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    const session = harness.store.get(KEY)!;
    const [round] = session.rounds;
    delete round!.grouping;
    harness.store.save({ ...session, rounds: [round!] });

    await publishNext(harness);

    assert.deepEqual(harness.grouped[1]?.previous, MODEL_GROUPING);
  });
});

test("re-opening an ended review is refused, with the way to ask for a new round", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    const ended = { ...harness.store.get(KEY)!, status: "ended" as const };
    harness.store.save(ended);

    const error = await refusal(open(harness));

    assert.equal(error.code, "session_ended");
    assert.ok(error.suggestions.some((line) => line.includes("--reopen")));
    assert.deepEqual(harness.store.get(KEY), ended);
  });
});

/** Who closed it is on the record; `lightspeed end` is not the reviewer's decision. */
test("open and publish on a review the agent ended say `lightspeed end` closed it", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    toWorking(harness.store);
    harness.store.save({ ...harness.store.get(KEY)!, status: "ended", endedBy: "agent" });

    const opened = await refusal(open(harness));
    const published = await refusal(publish(harness));

    for (const error of [opened, published]) {
      assert.equal(error.code, "session_ended");
      assert.match(error.message, /`lightspeed end` ended this review, not the reviewer/);
      assert.match(error.suggestions.join("\n"), /Only if the reviewer asks for another round/);
    }
  });
});

test("open on a review the reviewer ended still says the reviewer ended it", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.store.save({ ...harness.store.get(KEY)!, status: "ended", endedBy: "reviewer" });

    const error = await refusal(open(harness));

    assert.match(error.message, /^the reviewer ended this review/);
  });
});

test("--reopen opens a new round on a review the reviewer asked to continue", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.store.save({ ...harness.store.get(KEY)!, status: "ended" });

    await open(harness, { reopen: true });

    assert.equal(harness.announced[1]?.turn, "reviewer");
    assert.equal(harness.store.get(KEY)?.rounds.length, 2);
  });
});

test("starts the server when none is running", async () => {
  await withHarness(async (harness) => {
    const ports: number[] = [];

    await open(harness, {
      deps: { ...harness.deps, ensureServerRunning: async ({ port }) => void ports.push(port) },
    });

    assert.deepEqual(ports, [harness.config.port]);
  });
});

test("a browser command that does not exist is survivable, not a crash", async () => {
  launchBrowser("lsr-no-such-browser-command", "http://127.0.0.1:4388/session/abc");

  // The failure arrives asynchronously; an unhandled 'error' event would take
  // the whole CLI down after it had already done the useful work.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("publish ends a working turn: the --to notes land in their threads", async () => {
  await withHarness(async (harness) => {
    await open(harness);

    await publishNext(harness, { notes: [{ to: "main", text: "done: signed the tokens" }] });

    const stored = harness.store.get(KEY)!;
    const said = stored.conversation.flatMap((entry) => entry.prompts);
    assert.deepEqual(
      said.map((prompt) => ("comment" in prompt ? prompt.comment : undefined)),
      ["done: signed the tokens"],
    );
    assert.equal(stored.lastHandback?.verb, "publish");
  });
});

test("publish without --intent is refused before anything is extracted", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    toWorking(harness.store);

    const error = await refusal(publish(harness, { intents: [] }));

    assert.equal(error.code, "intent_missing");
    assert.match(error.suggestions.join(" "), /lightspeed publish feature-auth main --intent/);
    assert.equal(harness.grouped.length, 1);
  });
});

test("publish while digesting is refused with work and reply named", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.store.save({
      ...harness.store.get(KEY)!,
      turn: agentDigesting("2025-01-01T00:00:00Z"),
    });

    const error = await refusal(publish(harness));

    assert.equal(error.code, "turn_still_yours");
    assert.match(error.suggestions.join(" "), /lightspeed work/);
    assert.match(error.suggestions.join(" "), /lightspeed reply/);
    assert.equal(harness.store.get(KEY)?.rounds.length, 1);
  });
});

test("publish while the reviewer holds the turn is refused with the way to listen", async () => {
  await withHarness(async (harness) => {
    await open(harness);

    const error = await refusal(publish(harness));

    assert.equal(error.code, "turn_not_yours");
    assert.match(error.suggestions.join(" "), /lightspeed open feature-auth main/);
  });
});

test("publish with no review open says to open one", async () => {
  await withHarness(async (harness) => {
    const error = await refusal(publish(harness));

    assert.equal(error.code, "session_not_found");
  });
});

test("publish on a HEAD that has not moved is refused: there is no round to open", async () => {
  await withHarness(async (harness) => {
    const deps: RoundDeps = { ...harness.deps, extractDiff: () => extractedAt(1) };
    await open(harness, { deps });
    toWorking(harness.store);

    const error = await refusal(publish(harness, { deps }));

    assert.equal(error.code, "nothing_to_publish");
    assert.equal(harness.store.get(KEY)?.rounds.length, 1);
  });
});

test("publish naming an item that does not exist posts nothing", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    toWorking(harness.store);

    const error = await refusal(publish(harness, { notes: [{ to: "t9", text: "done" }] }));

    assert.equal(error.code, "feedback_item_unknown");
    assert.equal(harness.store.get(KEY)?.rounds.length, 1);
  });
});

/** A refusal the session file already shows costs no extraction and no model call. */
test("publish checks the turn, the review and the tip before it groups anything", async () => {
  await withHarness(async (harness) => {
    const repoRoot = newRepo("lsr-publish-");
    git(repoRoot, "commit", "--allow-empty", "-m", "base");
    git(repoRoot, "checkout", "-b", BRANCH);
    git(repoRoot, "commit", "--allow-empty", "-m", "tip");
    const tip = git(repoRoot, "rev-parse", "HEAD");
    const deps: RoundDeps = {
      ...harness.deps,
      extractDiff: () => ({ ...extractedAt(1), headCommit: tip }),
    };
    const key = sessionKey(repoRoot, BRANCH, BASE);
    await open(harness, { repoRoot, deps });
    const grouped = harness.grouped.length;
    const tryPublish = () => refusal(publish(harness, { repoRoot, deps }));

    const reviewers = await tryPublish();
    harness.store.save({ ...harness.store.get(key)!, turn: agentDigesting(AT_START) });
    const digesting = await tryPublish();
    harness.store.save({ ...harness.store.get(key)!, turn: agentWorking(AT_START, "plan") });
    const unmoved = await tryPublish();
    harness.store.save({ ...harness.store.get(key)!, status: "ended" });
    const ended = await tryPublish();

    assert.deepEqual(
      [reviewers, digesting, unmoved, ended].map((error) => error.code),
      ["turn_not_yours", "turn_still_yours", "nothing_to_publish", "session_ended"],
    );
    assert.equal(harness.grouped.length, grouped, "no model call for a publish refused anyway");
    assert.match(ended.suggestions.join("\n"), /lightspeed approvals feature-auth main/);
  });
});

/** Killed mid-wait, re-run: the server knows the round and posts nothing twice. */
test("a re-run publish opens no second round and goes back to the wait", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    const deps: RoundDeps = { ...harness.deps, extractDiff: () => extractedAt(2) };
    const notes = [{ to: "main", text: "done: signed the tokens" }];
    await publishNext(harness, { deps, notes });

    const output = await publish(harness, { deps, notes });

    assert.equal(output, LISTENED);
    const stored = harness.store.get(KEY)!;
    assert.equal(stored.rounds.length, 2);
    assert.equal(stored.conversation.flatMap((entry) => entry.prompts).length, 1);
  });
});

test("before it waits, publish says the round is out and the exact command that recovers a kill", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.announced.length = 0;

    await publishNext(harness, {
      intents: ["sign the tokens", "drop the cookie"],
      notes: [{ to: "main", text: "done: signed" }],
    });

    const [shown] = harness.announced;
    assert.equal(shown?.round, 2);
    assert.equal(Object.keys(shown!).at(-1), "next");
    assert.match(
      ifKilled(shown),
      /lightspeed publish feature-auth main --intent 'sign the tokens' --intent 'drop the cookie' --to main 'done: signed'$/,
    );
  });
});

/** An apostrophe cannot be quoted in a line that pastes as printed: re-attaching recovers the wait. */
test("a publish whose words have an apostrophe prints a kill recovery that pastes as shown", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    harness.announced.length = 0;

    await publishNext(harness, {
      intents: ["the cookie's gone"],
      notes: [{ to: "main", text: "done: signed" }],
    });

    const printed = renderToon(harness.announced[0]!);
    const line = printed.split("\n").find((one) => one.includes("if_killed"))!;
    assert.doesNotMatch(line.slice(line.indexOf("lightspeed"), -1), /[\\"']/);
    assert.match(line, /: lightspeed open feature-auth main"$/);
  });
});

test("a publish the server recognises as a re-run says so before it waits again", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    const deps: RoundDeps = { ...harness.deps, extractDiff: () => extractedAt(2) };
    await publishNext(harness, { deps });
    harness.announced.length = 0;

    await publish(harness, { deps });

    assert.equal(harness.announced[0]?.rerun, true);
    assert.match(ifKilled(harness.announced[0]), /lightspeed publish feature-auth main/);
  });
});

interface PublishedAtTip {
  repoRoot: string;
  key: string;
  deps: RoundDeps;
  extractions: () => number;
}

/** A real branch whose tip is the round the last publish opened. */
async function publishedAtTip(harness: Harness): Promise<PublishedAtTip> {
  const repoRoot = newRepo("lsr-publish-");
  git(repoRoot, "commit", "--allow-empty", "-m", "base");
  git(repoRoot, "checkout", "-b", BRANCH);
  git(repoRoot, "commit", "--allow-empty", "-m", "tip");
  const tip = git(repoRoot, "rev-parse", "HEAD");
  let extractions = 0;
  const deps: RoundDeps = {
    ...harness.deps,
    extractDiff: () => {
      extractions += 1;
      return {
        ...extractedAt(extractions),
        headCommit: extractions === 1 ? "1".repeat(40) : tip,
      };
    },
  };
  const key = sessionKey(repoRoot, BRANCH, BASE);
  await open(harness, { repoRoot, deps });
  harness.store.save({
    ...harness.store.get(key)!,
    turn: agentWorking(new Date().toISOString(), "the plan"),
  });
  await publish(harness, { repoRoot, deps });
  harness.announced.length = 0;
  return { repoRoot, key, deps, extractions: () => extractions };
}

/**
 * Re-run after the round opened and the turn went back to the reviewer: the
 * branch tip is still the round's HEAD, so the CLI waits without asking the
 * server — nor paying for an extraction — again.
 */
test("a re-run publish on a tip the last round already shows goes straight back to the wait", async () => {
  await withHarness(async (harness) => {
    const { repoRoot, key, deps, extractions } = await publishedAtTip(harness);

    const output = await publish(harness, { repoRoot, deps });

    assert.equal(output, LISTENED);
    assert.equal(extractions(), 2);
    assert.equal(harness.store.get(key)?.rounds.length, 2);
    assert.match(
      String(harness.announced[0]?.message),
      /already published; waiting for the reviewer's Send/,
    );
    assert.equal(harness.announced[0]?.rerun, true);
    assert.match(ifKilled(harness.announced[0]), /lightspeed publish feature-auth main/);
  });
});

/** Unacknowledged: the Send reached a publish that died before saying so. */
function heldUnacked(store: SessionStore, key: string): void {
  store.save({
    ...store.get(key)!,
    batch: { id: "b2", prompts: [], at: AT_START, acked: false },
    turn: agentDigesting(AT_START),
  });
}

test("a server-recognised re-run over a batch never acknowledged says it hands that batch back", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    const deps: RoundDeps = { ...harness.deps, extractDiff: () => extractedAt(2) };
    await publishNext(harness, { deps });
    heldUnacked(harness.store, KEY);
    harness.announced.length = 0;

    await publish(harness, { deps });

    const [shown] = harness.announced;
    assert.equal(shown?.rerun, true);
    assert.equal(shown?.turn, "agent digesting");
    assert.match(String(shown?.message), /handing back the batch you are digesting/);
    assert.equal(shown?.next, undefined, "no wait, so no kill recovery");
  });
});

test("a local re-run over a batch never acknowledged says it hands that batch back", async () => {
  await withHarness(async (harness) => {
    const { repoRoot, key, deps } = await publishedAtTip(harness);
    heldUnacked(harness.store, key);

    await publish(harness, { repoRoot, deps });

    const [shown] = harness.announced;
    assert.equal(shown?.rerun, true);
    assert.equal(shown?.turn, "agent digesting");
    assert.match(
      String(shown?.message),
      /already published; handing back the batch you are digesting/,
    );
    assert.equal(shown?.next, undefined, "no wait, so no kill recovery");
  });
});

/**
 * A batch delivered and read since the last publish, and new words: not that
 * publish re-run, so the notes are not dropped behind "already published".
 */
test("a publish on an unmoved tip after a newer batch was read is refused, naming reply", async () => {
  await withHarness(async (harness) => {
    const { repoRoot, key, deps, extractions } = await publishedAtTip(harness);
    harness.store.save({
      ...harness.store.get(key)!,
      batch: { id: "b2", prompts: [], at: AT_START, acked: true },
      turn: agentDigesting(AT_START),
    });

    const error = await refusal(
      publish(harness, {
        repoRoot,
        deps,
        notes: [{ to: "main", text: "done: in the last round" }],
      }),
    );

    assert.equal(error.code, "turn_still_yours");
    assert.match(error.suggestions.join(" "), /lightspeed reply/);
    assert.equal(harness.announced.length, 0);
    assert.equal(extractions(), 2);
  });
});

test("a publish with new words on the reviewer's turn is refused, not taken for a re-run", async () => {
  await withHarness(async (harness) => {
    const { repoRoot, deps } = await publishedAtTip(harness);

    const error = await refusal(publish(harness, { repoRoot, deps, intents: ["something else"] }));

    assert.equal(error.code, "turn_not_yours");
    assert.equal(harness.announced.length, 0);
  });
});

test("reads the branch pair and flags off the command line", () => {
  assert.deepEqual(parseOpenArgs(["feature-auth", "main"]), {
    branch: "feature-auth",
    base: "main",
    open: true,
    model: undefined,
    reopen: false,
    intents: [],
  });
});

test("--intent is repeatable and keeps the order it was given in", () => {
  assert.deepEqual(
    parseOpenArgs(["feature-auth", "--intent", "sign the tokens", "--intent", "drop /login"])
      .intents,
    ["sign the tokens", "drop /login"],
  );
});

test("a blank intent says nothing, so it does not count as one", () => {
  assert.deepEqual(parseOpenArgs(["feature-auth", "--intent", "   "]).intents, []);
  assert.deepEqual(parseOpenArgs(["feature-auth", "--intent"]).intents, []);
});

test("the intents ride onto the round, and the agent is told what was recorded", async () => {
  await withHarness(async (harness) => {
    const intents = ["sign the tokens", "drop the legacy /login handler"];

    await open(harness, { intents });

    assert.deepEqual((harness.announced[0]?.session as { intents: string[] }).intents, intents);
    assert.deepEqual(harness.store.get(KEY)?.rounds.at(-1)?.intents, intents);
  });
});

test("a later round states its own intent without disturbing approvals", async () => {
  await withHarness(async (harness) => {
    await open(harness, { intents: ["first why"] });
    const session = harness.store.get(KEY)!;
    harness.store.save({
      ...session,
      approved: ["src/api/users.ts"],
      rounds: session.rounds.map((round) => ({ ...round, approvedAtEnd: ["src/api/users.ts"] })),
    });

    await publishNext(harness, { intents: ["second why"] });

    const stored = harness.store.get(KEY)!;
    assert.deepEqual(
      stored.rounds.map((round) => round.intents),
      [["first why"], ["second why"]],
    );
    assert.deepEqual(stored.approved, ["src/api/users.ts"]);
  });
});

test("--reopen is off unless the command line says so", () => {
  assert.equal(parseOpenArgs(["feature-auth"]).reopen, false);
  assert.equal(parseOpenArgs(["feature-auth", "--reopen"]).reopen, true);
});

test("--base names the base branch when it is not positional", () => {
  assert.equal(parseOpenArgs(["feature-auth", "--base", "develop"]).base, "develop");
  assert.equal(parsePublishArgs(["feature-auth", "--base", "develop"]).base, "develop");
});

test("an unknown flag is refused, with the flags that do exist", () => {
  assert.throws(
    () => parseOpenArgs(["feature-auth", "main", "--no-opne"]),
    (error: Error) => {
      assert.match(error.message, /unknown flag --no-opne/);
      assert.match((error as AxiError).suggestions.join(" "), /--intent/);
      assert.equal((error as AxiError).code, "unknown_flag");
      return true;
    },
  );
  assert.throws(() => parsePublishArgs(["--wait"]), /unknown flag --wait/);
});

test("a mistyped flag is not read as the base branch", () => {
  assert.throws(() => parseOpenArgs(["feature-auth", "--intnet", "why"]), /unknown flag --intnet/);
});

test("--no-open and --model are picked up wherever they appear", () => {
  assert.deepEqual(parseOpenArgs(["--no-open", "feature-auth", "--model", "anthropic/opus"]), {
    branch: "feature-auth",
    base: undefined,
    open: false,
    model: "anthropic/opus",
    reopen: false,
    intents: [],
  });
});

test("publish reads --to pairs wherever they sit, and the rest as usual", () => {
  assert.deepEqual(
    parsePublishArgs([
      "--to",
      "t1",
      "done: renamed",
      "feature-auth",
      "--intent",
      "rename",
      "--to",
      "main",
      "all green",
    ]),
    {
      branch: "feature-auth",
      base: undefined,
      model: undefined,
      intents: ["rename"],
      notes: [
        { to: "t1", text: "done: renamed" },
        { to: "main", text: "all green" },
      ],
    },
  );
});

test("open reports the ledger it is writing to, with its path", async () => {
  await withHarness(async (harness) => {
    await open(harness);

    assert.deepEqual(harness.announced[0]?.ledger, { status: "on", path: harness.ledger?.path });
  }, "on");
});

test("open reports the ledger as off when feedback logging is disabled", async () => {
  await withHarness(async (harness) => {
    await open(harness);

    assert.deepEqual(harness.announced[0]?.ledger, { status: "off" });
  });
});

test("a degraded ledger is reported with a reason and a help line, not an error", async () => {
  await withHarness(async (harness) => {
    await open(harness);

    const shown = harness.announced[0]!;
    const ledger = shown.ledger as { status: string; reason: string };
    assert.equal(ledger.status, "degraded");
    assert.match(ledger.reason, /ENOTDIR|not a directory/i);
    assert.ok((shown.help as string[]).some((line) => /ledger/i.test(line)));
  }, "broken");
});

/** Read top to bottom, the same two facts in the same order: a flip reads as a different block. */
function roundBeforeTurn(block: StructuredOutput | undefined): void {
  const keys = Object.keys(block ?? {});
  assert.ok(keys.includes("round") && keys.includes("turn"), keys.join(", "));
  assert.ok(keys.indexOf("round") < keys.indexOf("turn"), keys.join(", "));
}

test("every block before a wait names the round before the turn", async () => {
  await withHarness(async (harness) => {
    await open(harness);
    await open(harness, { intents: [] });
    const deps: RoundDeps = { ...harness.deps, extractDiff: () => extractedAt(2) };
    await publishNext(harness, { deps });
    await publish(harness, { deps });

    const [fresh, reattached, published, rerun] = harness.announced;
    assert.equal(rerun?.rerun, true);
    for (const block of [fresh, reattached, published, rerun]) roundBeforeTurn(block);
  });
});

test("a local publish re-run names the round before the turn", async () => {
  await withHarness(async (harness) => {
    const { repoRoot, deps } = await publishedAtTip(harness);

    await publish(harness, { repoRoot, deps });

    assert.equal(harness.announced[0]?.rerun, true);
    roundBeforeTurn(harness.announced[0]);
  });
});
