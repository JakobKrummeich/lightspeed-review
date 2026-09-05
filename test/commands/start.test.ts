import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AxiError } from "axi-sdk-js";
import type { LightspeedConfig } from "../../src/config.ts";
import type { GroupDiffInput, GroupingMode, GroupingResult } from "../../src/llm/grouping.ts";
import type { DiffFile, ExtractedDiff } from "../../src/diff-extract.ts";
import { parseStartArgs, runStart, type StartDeps } from "../../src/commands/start.ts";
import { launchBrowser } from "../../src/commands/open-browser.ts";
import { ReviewError } from "../../src/errors.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import { LedgerStore } from "../../src/ledger/store.ts";
import { freePort } from "../helpers/ports.ts";

/** `undefined` stands for `feedbackLog: "off"`; a blocked path for a broken disk. */
function harnessLedger(kind: "on" | "off" | "broken"): LedgerStore | undefined {
  if (kind === "off") return undefined;
  const dir = mkdtempSync(join(tmpdir(), "lsr-start-ledger-"));
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

const extracted: ExtractedDiff = {
  files: [diffFile("src/api/users.ts"), diffFile("src/auth/token.ts")],
  stats: { files_changed: 2, insertions: 2, deletions: 2, binary_skipped: 1 },
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  commits: ["sign the tokens"],
};

interface Harness {
  config: LightspeedConfig;
  deps: StartDeps;
  store: SessionStore;
  ledger: LedgerStore | undefined;
  opened: string[];
  /** Every grouping request the fake model saw, in order. */
  grouped: GroupDiffInput[];
}

/** A real review server on a real port: only the diff and the LLM are faked. */
async function withHarness(
  body: (harness: Harness) => Promise<void>,
  ledgerKind: "on" | "off" | "broken" = "off",
): Promise<void> {
  const port = await freePort();
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-start-"));
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
  const deps: StartDeps = {
    extractDiff: () => extracted,
    groupDiff: async (input) => {
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
  };
  try {
    await body({ config, deps, store, ledger, opened, grouped });
  } finally {
    await server.stop();
  }
}

test("creates the session and reports it with diff aggregates and group sizes", async () => {
  await withHarness(async ({ config, deps, store }) => {
    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
    });

    const key = sessionKey(REPO, BRANCH, BASE);
    assert.deepEqual(output.session, {
      key,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      url: `http://127.0.0.1:${config.port}/session/${key}`,
      status: "open",
    });
    assert.deepEqual(output.diff, extracted.stats);
    assert.deepEqual(output.groups, [
      { name: "API Handlers", files: 1 },
      { name: "Auth", files: 1 },
    ]);
    assert.equal(store.get(key)?.groups.length, 2);
  });
});

test("records the commits the diff was taken between, so whole files can be read", async () => {
  await withHarness(async ({ config, deps, store }) => {
    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });

    const record = store.get(sessionKey(REPO, BRANCH, BASE));
    assert.equal(record?.baseCommit, extracted.baseCommit);
    assert.equal(record?.headCommit, extracted.headCommit);
  });
});

test("reports why grouping was skipped so the agent can see the LLM was not used", async () => {
  await withHarness(async ({ config, deps }) => {
    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps: {
        ...deps,
        groupDiff: async ({ files }) => ({
          groups: [{ name: "All Changes", rationale: "small diff", files }],
          mode: "skipped",
          reason: "1 changed file: nothing to order",
        }),
      },
    });

    assert.deepEqual(output.grouping, {
      mode: "skipped",
      reason: "1 changed file: nothing to order",
    });
  });
});

test("tells the agent to poll in the foreground for this branch pair", async () => {
  await withHarness(async ({ config, deps }) => {
    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
    });

    const help = output.help as string[];
    assert.ok(help.some((line) => line.includes(`poll ${BRANCH} ${BASE}`)));
    assert.ok(help.some((line) => /foreground/.test(line)));
  });
});

test("opens the review page in a browser", async () => {
  await withHarness(async ({ config, deps, opened }) => {
    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
    });

    assert.deepEqual(opened, [(output.session as { url: string }).url]);
  });
});

test("--no-open leaves the browser alone", async () => {
  await withHarness(async ({ config, deps, opened }) => {
    await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
      open: false,
    });

    assert.deepEqual(opened, []);
  });
});

test("re-running keeps the conversation and the approvals the diff has not undone", async () => {
  await withHarness(async ({ config, deps, store }) => {
    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });
    const key = sessionKey(REPO, BRANCH, BASE);
    store.save({
      ...store.get(key)!,
      conversation: [{ role: "reviewer", at: "2025-01-01T00:00:00.000Z", prompts: [] }],
      approved: ["src/api/users.ts"],
    });

    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });

    assert.equal(store.get(key)?.conversation.length, 1);
    // The branch did not move between the two runs, so the file the reviewer
    // ticked is the file they read — whether or not they ended the round.
    assert.deepEqual(store.get(key)?.approved, ["src/api/users.ts"]);
  });
});

/**
 * `start` once fed ticked files to the model and it sank them; nothing orders on approval any
 * more, so what the reviewer ticked stays between the browser and the server.
 */
test("the grouping call carries last round's reading order and no word of approval", async () => {
  await withHarness(async ({ config, deps, store, grouped }) => {
    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });
    const key = sessionKey(REPO, BRANCH, BASE);
    const session = store.get(key)!;
    // The round is left open, as "Send to Agent" leaves it: the ticks are in
    // `approved` and nowhere else.
    store.save({ ...session, approved: ["src/api/users.ts"] });

    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });

    assert.equal(grouped.length, 2);
    // Round one: no session on disk, so nothing to hold steady and no field.
    assert.deepEqual(Object.keys(grouped[0]!).toSorted(), ["config", "files", "intents"]);
    assert.deepEqual(Object.keys(grouped[1]!).toSorted(), [
      "config",
      "files",
      "intents",
      "previous",
    ]);
    // Round two: the grouping the reviewer read, in the order they read it.
    assert.deepEqual(grouped[1]?.previous, [
      { name: "API Handlers", files: ["src/api/users.ts"] },
      { name: "Auth", files: ["src/auth/token.ts"] },
    ]);
  });
});

/**
 * The two-group grouping the harness returns, or the one-group catch-all every
 * degraded path returns, depending on the mode the round is scripted with.
 */
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

/** Runs `start` once per mode, recording what each grouping call was given. */
async function rounds(
  harness: Harness,
  modes: GroupingMode[],
): Promise<{ calls: GroupDiffInput[] }> {
  const calls: GroupDiffInput[] = [];
  const deps: StartDeps = {
    ...harness.deps,
    groupDiff: async (input) => {
      calls.push(input);
      return groupingFor(modes[calls.length - 1] ?? "llm", input.files);
    },
  };
  const { config } = harness;
  for (let round = 0; round < modes.length; round += 1) {
    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });
  }
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
    // And the mode is on the round, which is what says so.
    const stored = harness.store.get(sessionKey(REPO, BRANCH, BASE))!;
    assert.deepEqual(
      stored.rounds.map((round) => round.grouping),
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

/**
 * Pre-field rounds cannot say what they were, and nearly all were the model's: the field catches
 * known degradation, not rounds that cannot prove they did not degrade.
 */
test("a round from before the mode was recorded still carries its grouping", async () => {
  await withHarness(async ({ config, deps, store, grouped }) => {
    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });
    const key = sessionKey(REPO, BRANCH, BASE);
    const session = store.get(key)!;
    const [round] = session.rounds;
    delete round!.grouping;
    store.save({ ...session, rounds: [round!] });

    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });

    assert.deepEqual(grouped[1]?.previous, MODEL_GROUPING);
  });
});

test("re-starting an ended review is refused, with the way to ask for a new round", async () => {
  await withHarness(async ({ config, deps, store }) => {
    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });
    const key = sessionKey(REPO, BRANCH, BASE);
    const ended = { ...store.get(key)!, status: "ended" as const };
    store.save(ended);

    const error = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
    }).catch((thrown: unknown) => thrown);

    assert.ok(error instanceof ReviewError);
    assert.equal(error.code, "session_ended");
    assert.ok(error.suggestions.some((line) => line.includes("--reopen")));
    assert.deepEqual(store.get(key), ended);
  });
});

test("--reopen starts a new round on a review the reviewer asked to continue", async () => {
  await withHarness(async ({ config, deps, store }) => {
    await runStart({ repoRoot: REPO, branch: BRANCH, base: BASE, intents: INTENTS, config, deps });
    const key = sessionKey(REPO, BRANCH, BASE);
    store.save({ ...store.get(key)!, status: "ended" });

    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
      reopen: true,
    });

    assert.equal((output.session as { status: string }).status, "open");
    assert.equal(store.get(key)?.rounds.length, 2);
  });
});

test("starts the server when none is running", async () => {
  await withHarness(async ({ config, deps }) => {
    const ports: number[] = [];

    await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps: { ...deps, ensureServerRunning: async ({ port }) => void ports.push(port) },
    });

    assert.deepEqual(ports, [config.port]);
  });
});

test("a browser command that does not exist is survivable, not a crash", async () => {
  launchBrowser("lsr-no-such-browser-command", "http://127.0.0.1:4388/session/abc");

  // The failure arrives asynchronously; an unhandled 'error' event would take
  // the whole CLI down after it had already done the useful work.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("reads the branch pair and flags off the command line", () => {
  assert.deepEqual(parseStartArgs(["feature-auth", "main"]), {
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
    parseStartArgs(["feature-auth", "--intent", "sign the tokens", "--intent", "drop /login"])
      .intents,
    ["sign the tokens", "drop /login"],
  );
});

test("a blank intent says nothing, so it does not count as one", () => {
  assert.deepEqual(parseStartArgs(["feature-auth", "--intent", "   "]).intents, []);
  assert.deepEqual(parseStartArgs(["feature-auth", "--intent"]).intents, []);
});

test("the intents ride onto the round, and the agent is told what was recorded", async () => {
  await withHarness(async ({ config, deps, store }) => {
    const intents = ["sign the tokens", "drop the legacy /login handler"];

    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents,
      config,
      deps,
    });

    assert.deepEqual((output.session as { intents: string[] }).intents, intents);
    const round = store.get(sessionKey(REPO, BRANCH, BASE))?.rounds.at(-1);
    assert.deepEqual(round?.intents, intents);
  });
});

test("a later round states its own intent without disturbing approvals", async () => {
  await withHarness(async ({ config, deps, store }) => {
    await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: ["first why"],
      config,
      deps,
    });
    const key = sessionKey(REPO, BRANCH, BASE);
    const session = store.get(key)!;
    store.save({
      ...session,
      approved: ["src/api/users.ts"],
      rounds: session.rounds.map((round) => ({ ...round, approvedAtEnd: ["src/api/users.ts"] })),
    });

    await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: ["second why"],
      config,
      deps,
    });

    const stored = store.get(key)!;
    assert.deepEqual(
      stored.rounds.map((round) => round.intents),
      [["first why"], ["second why"]],
    );
    assert.deepEqual(stored.approved, ["src/api/users.ts"]);
  });
});

test("--reopen is off unless the command line says so", () => {
  assert.equal(parseStartArgs(["feature-auth", "--reopen"]).reopen, true);
});

test("--base names the base branch when it is not positional", () => {
  assert.deepEqual(parseStartArgs(["feature-auth", "--base", "develop"]), {
    branch: "feature-auth",
    base: "develop",
    open: true,
    model: undefined,
    reopen: false,
    intents: [],
  });
});

test("an unknown flag is refused, with the flags that do exist", () => {
  assert.throws(
    () => parseStartArgs(["feature-auth", "main", "--no-opne"]),
    (error: Error) => {
      assert.match(error.message, /unknown flag --no-opne/);
      assert.match((error as AxiError).suggestions.join(" "), /--intent/);
      assert.equal((error as AxiError).code, "VALIDATION_ERROR");
      return true;
    },
  );
});

/** The mistyped flag used to land in `positional[1]`, so the run failed on a
 * base branch called `--intnet` instead of on the typo. */
test("a mistyped flag is not read as the base branch", () => {
  assert.throws(() => parseStartArgs(["feature-auth", "--intnet", "why"]), /unknown flag --intnet/);
});

test("--no-open and --model are picked up wherever they appear", () => {
  assert.deepEqual(parseStartArgs(["--no-open", "feature-auth", "--model", "anthropic/opus"]), {
    branch: "feature-auth",
    base: undefined,
    open: false,
    model: "anthropic/opus",
    reopen: false,
    intents: [],
  });
});

test("start reports the ledger it is writing to, with its path", async () => {
  await withHarness(async ({ config, deps, ledger }) => {
    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
    });

    assert.deepEqual(output.ledger, { status: "on", path: ledger?.path });
    assert.ok((output.help as string[]).length > 0);
  }, "on");
});

test("start reports the ledger as off when feedback logging is disabled", async () => {
  await withHarness(async ({ config, deps }) => {
    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
    });

    assert.deepEqual(output.ledger, { status: "off" });
  });
});

test("a degraded ledger is reported with a reason and a help line, not an error", async () => {
  await withHarness(async ({ config, deps }) => {
    const output = await runStart({
      repoRoot: REPO,
      branch: BRANCH,
      base: BASE,
      intents: INTENTS,
      config,
      deps,
    });

    const ledger = output.ledger as { status: string; reason: string };
    assert.equal(ledger.status, "degraded");
    assert.match(ledger.reason, /ENOTDIR|not a directory/i);
    assert.ok((output.help as string[]).some((line) => /ledger/i.test(line)));
  }, "broken");
});
