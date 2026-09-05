import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Model, MutableModels } from "@earendil-works/pi-ai";
import type { LightspeedConfig } from "../../src/config.ts";
import type { DiffFile } from "../../src/diff-extract.ts";
import { ReviewError } from "../../src/errors.ts";
import { FALLBACK_GROUP_NAME, UNGROUPED_RATIONALE, groupDiff } from "../../src/llm/grouping.ts";

function diffFile(path: string): DiffFile {
  return {
    path,
    status: "modified",
    diff: `diff --git a/${path} b/${path}\n@@ -1 +1 @@\n-old\n+new`,
    insertions: 1,
    deletions: 1,
    oversized: false,
  };
}

const eightFiles = Array.from({ length: 8 }, (_, index) => diffFile(`src/file-${index}.ts`));

function config(overrides: Partial<LightspeedConfig> = {}): LightspeedConfig {
  return {
    model: "faux/faux-1",
    thinking: "off",
    port: 4388,
    stateDir: "/tmp/lsr",
    feedbackLog: "off",
    classify: { mechanical: [], guardrail: [] },
    ...overrides,
  };
}

function modelsReplying(replies: string[]): {
  models: MutableModels;
  prompts: string[];
  seen: { model?: Model<string> };
} {
  const prompts: string[] = [];
  const seen: { model?: Model<string> } = {};
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    replies.map((reply) => (context, _options, _state, model) => {
      const last = context.messages.at(-1);
      seen.model = model;
      prompts.push(
        typeof last?.content === "string" ? last.content : JSON.stringify(last?.content),
      );
      return fauxAssistantMessage(reply);
    }),
  );
  return { models, prompts, seen };
}

/** Splits the paths in half so both groups are always non-empty. */
function replyGrouping(files: DiffFile[]): string {
  const half = Math.ceil(files.length / 2);
  return JSON.stringify({
    groups: [
      {
        name: "Core",
        rationale: "main change",
        tier: "study",
        files: files.slice(0, half).map((f) => f.path),
      },
      {
        name: "Rest",
        rationale: "the others",
        tier: "study",
        files: files.slice(half).map((f) => f.path),
      },
    ],
  });
}

test("the providers the config names decide where the grouping call goes", async () => {
  const files = eightFiles.slice(0, 4);
  const { models, seen } = modelsReplying([replyGrouping(files)]);

  const result = await groupDiff({
    files,
    config: config({ providers: { faux: { baseUrl: "http://localhost:3001" } } }),
    intents: [],
    models,
  });

  assert.equal(result.mode, "llm");
  assert.equal(seen.model?.baseUrl, "http://localhost:3001");
});

test("a one-file diff never reaches the model: there is nothing to order", async () => {
  const files = eightFiles.slice(0, 1);
  const { models, prompts } = modelsReplying([]);

  const result = await groupDiff({ files, config: config(), intents: [], models });

  assert.equal(result.mode, "skipped");
  assert.equal(prompts.length, 0);
  assert.deepEqual(
    result.groups.map((group) => group.name),
    [FALLBACK_GROUP_NAME],
  );
  assert.equal(result.groups[0]?.files.length, 1);
  assert.match(result.reason ?? "", /1 changed file: nothing to order/);
});

test("an empty diff produces no groups", async () => {
  const { models } = modelsReplying([]);

  const result = await groupDiff({
    files: [],
    config: config(),
    intents: [],
    models,
  });

  assert.deepEqual(result.groups, []);
  assert.equal(result.mode, "skipped");
});

test("a valid reply becomes ordered groups holding the real diff files", async () => {
  const { models } = modelsReplying([replyGrouping(eightFiles)]);

  const result = await groupDiff({
    files: eightFiles,
    config: config(),
    intents: [],
    models,
  });

  assert.equal(result.mode, "llm");
  assert.deepEqual(
    result.groups.map((group) => group.name),
    ["Core", "Rest"],
  );
  assert.equal(result.groups[0]?.files.length, 4);
  assert.equal(result.groups[0]?.files[0]?.diff, eightFiles[0]?.diff);
});

test("the model's rationale rides its group all the way out", async () => {
  const { models } = modelsReplying([replyGrouping(eightFiles)]);

  const result = await groupDiff({ files: eightFiles, config: config(), intents: [], models });

  assert.equal(result.groups[0]?.rationale, "main change");
  assert.equal(result.groups[1]?.rationale, "the others");
});

test("a model still writing the retired `watch` sentence is neither sent back nor believed", async () => {
  // The field is gone from the contract; a model answering off a cached prefix
  // or a copied example may still write it. Not worth a repair round, and not
  // carried into the review either: nothing there would show it.
  const stale = replyGrouping(eightFiles).replace(
    '"rationale":"main change"',
    '"rationale":"main change","watch":"the risky part"',
  );
  const { models, prompts } = modelsReplying([stale]);

  const result = await groupDiff({ files: eightFiles, config: config(), intents: [], models });

  assert.equal(result.mode, "llm");
  assert.equal(prompts.length, 1);
  assert.ok(!("watch" in result.groups[0]!));
});

/** One chapter of bulk and one of code, tiered as the model saw them. */
function replyTiered(sweep: string[], study: string[]): string {
  return JSON.stringify({
    groups: [
      { name: "Core", rationale: "the change", tier: "study", files: study },
      { name: "Bulk", rationale: "the rest", tier: "sweep", files: sweep },
    ],
  });
}

test("a swept chapter of nothing but bulk reaches the reviewer swept", async () => {
  const files = [diffFile("src/a.ts"), diffFile("README.md"), diffFile("docs/setup.md")];
  const { models } = modelsReplying([replyTiered(["README.md", "docs/setup.md"], ["src/a.ts"])]);

  const result = await groupDiff({ files, config: config(), intents: [], models });

  assert.deepEqual(
    result.groups.map((group) => group.tier),
    ["study", "sweep"],
  );
});

test("a chapter the model swept over a file worth judging is raised by the code", async () => {
  // The one direction the pipeline moves a tier in: a chapter carrying a file no
  // rule calls bulk is read, whatever the reply said.
  const files = [diffFile("src/a.ts"), diffFile("README.md"), diffFile("src/auth.ts")];
  const { models } = modelsReplying([replyTiered(["README.md", "src/auth.ts"], ["src/a.ts"])]);

  const result = await groupDiff({ files, config: config(), intents: [], models });

  assert.deepEqual(
    result.groups.map((group) => group.tier),
    ["study", "study"],
  );
});

test("the tests chapter the code adds is tiered like every other chapter", async () => {
  const files = [diffFile("src/a.ts"), diffFile("README.md"), diffFile("test/a.test.ts")];
  const { models } = modelsReplying([replyTiered(["README.md"], ["src/a.ts", "test/a.test.ts"])]);

  const result = await groupDiff({ files, config: config(), intents: [], models });

  assert.deepEqual(
    result.groups.map((group) => [group.name, group.tier]),
    [
      ["Core", "study"],
      ["Bulk", "sweep"],
      ["Tests", "study"],
    ],
  );
});

test("the one chapter a degraded round leaves is read, never swept", async () => {
  const { models } = modelsReplying(["nope", "still nope", "nope again"]);

  const degraded = await groupDiff({ files: eightFiles, config: config(), intents: [], models });
  const single = await groupDiff({
    files: [diffFile("README.md")],
    config: config(),
    intents: [],
    models: modelsReplying([]).models,
  });

  assert.equal(degraded.mode, "fallback");
  assert.equal(degraded.groups[0]?.tier, "study");
  // Bulk by every rule there is, and still study: nothing here read the diff.
  assert.equal(single.mode, "skipped");
  assert.equal(single.groups[0]?.tier, "study");
});

test("malformed JSON is repaired inside the same conversation", async () => {
  const { models, prompts } = modelsReplying(["not json at all", replyGrouping(eightFiles)]);

  const result = await groupDiff({
    files: eightFiles,
    config: config(),
    intents: [],
    models,
  });

  assert.equal(result.mode, "llm");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /not valid JSON/);
});

test("a missing file is reported back to the model and repaired", async () => {
  const incomplete = JSON.stringify({
    groups: [{ name: "Core", rationale: "r", tier: "study", files: [eightFiles[0]!.path] }],
  });
  const { models, prompts } = modelsReplying([incomplete, replyGrouping(eightFiles)]);

  const result = await groupDiff({
    files: eightFiles,
    config: config(),
    intents: [],
    models,
  });

  assert.equal(result.mode, "llm");
  assert.match(prompts[1] ?? "", /missing/);
  assert.match(prompts[1] ?? "", /src\/file-7\.ts/);
});

/** The same two groups, with one rationale written at the reviewer instead of about the code. */
function replyOrdering(files: DiffFile[]): string {
  return replyGrouping(files).replace(
    '"rationale":"main change"',
    '"rationale":"Verify the reference is passed."',
  );
}

test("a sentence that orders the reviewer about is sent back to be rewritten", async () => {
  // The prompt has forbidden `verify` for as long as the field has existed and
  // models write it anyway; the reviewer reads what the validator lets through.
  const { models, prompts } = modelsReplying([
    replyOrdering(eightFiles),
    replyGrouping(eightFiles),
  ]);

  const result = await groupDiff({ files: eightFiles, config: config(), intents: [], models });

  assert.equal(result.mode, "llm");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /order to the reader/);
  assert.match(prompts[1] ?? "", /Verify the reference is passed\./);
  assert.equal(result.groups[0]?.rationale, "main change");
});

test("a model that will not rewrite the sentence keeps its grouping anyway", async () => {
  // Wording is worth another call and never worth the review: one undivided
  // chapter is a far worse read than a chapter whose rationale is phrased badly.
  const ordering = replyOrdering(eightFiles);
  const { models, prompts } = modelsReplying([ordering, ordering, ordering]);

  const result = await groupDiff({ files: eightFiles, config: config(), intents: [], models });

  assert.equal(result.mode, "llm");
  assert.equal(prompts.length, 3);
  assert.equal(result.groups.length, 2);
  assert.equal(result.groups[0]?.rationale, "Verify the reference is passed.");
});

test("three invalid replies fall back to a single All Changes group", async () => {
  const { models, prompts } = modelsReplying(["nope", "still nope", "nope again", "too late"]);

  const result = await groupDiff({
    files: eightFiles,
    config: config(),
    intents: [],
    models,
  });

  assert.equal(result.mode, "fallback");
  assert.equal(prompts.length, 3);
  assert.deepEqual(
    result.groups.map((group) => group.name),
    [FALLBACK_GROUP_NAME],
  );
  assert.equal(result.groups[0]?.files.length, eightFiles.length);
});

test("a one-file diff of a test file is still skipped, not reordered", async () => {
  // `skipped` reports "nothing to order", and a call that then orders the file
  // contradicts its own sentence.
  const files = [diffFile("test/a.test.ts")];
  const { models, prompts } = modelsReplying([]);

  const result = await groupDiff({ files, config: config(), intents: [], models });

  assert.equal(result.mode, "skipped");
  assert.equal(prompts.length, 0);
  assert.deepEqual(
    result.groups.map((group) => group.name),
    [FALLBACK_GROUP_NAME],
  );
});

test("a fallback over nothing but tests keeps its All Changes group", async () => {
  const files = Array.from({ length: 8 }, (_, index) => diffFile(`test/file-${index}.test.ts`));
  const { models } = modelsReplying(["nope", "still nope", "nope again"]);

  const result = await groupDiff({ files, config: config(), intents: [], models });

  assert.equal(result.mode, "fallback");
  assert.deepEqual(
    result.groups.map((group) => group.name),
    [FALLBACK_GROUP_NAME],
  );
  assert.equal(result.groups[0]?.files.length, files.length);
});

test("the fallback group lets its tests trail too", async () => {
  const files = [...eightFiles, diffFile("test/file-0.test.ts")];
  const { models } = modelsReplying(["nope", "still nope", "nope again"]);

  const result = await groupDiff({ files, config: config(), intents: [], models });

  assert.equal(result.mode, "fallback");
  assert.deepEqual(
    result.groups.map((group) => group.name),
    [FALLBACK_GROUP_NAME, "Tests"],
  );
});

test("a provider failure degrades to the fallback group instead of blocking review", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 503" }),
  ]);

  const result = await groupDiff({
    files: eightFiles,
    config: config(),
    intents: [],
    models,
  });

  assert.equal(result.mode, "fallback");
  assert.match(result.reason ?? "", /upstream 503/);
});

/**
 * The model once got the ticks and sank what they marked, moving the review between rounds;
 * nothing about approval is sent now, so there is nothing to order on by accident.
 */
test("nothing the reviewer approved is sent to the model", async () => {
  const { models, prompts } = modelsReplying([replyGrouping(eightFiles)]);

  await groupDiff({ files: eightFiles, config: config(), intents: [], models });

  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0] ?? "", /approv/i);
});

/** The learned reading order is the one thing carried across rounds, so the model can keep it. */
test("last round's grouping reaches the model when there is one", async () => {
  const { models, prompts } = modelsReplying([replyGrouping(eightFiles)]);

  await groupDiff({
    files: eightFiles,
    config: config(),
    intents: [],
    previous: [{ name: "Core", files: ["src/file-0.ts", "src/file-1.ts"] }],
    models,
  });

  assert.match(prompts[0] ?? "", /^1\. Core — src\/file-0\.ts, src\/file-1\.ts$/m);
});

test("a first round sends no previous grouping at all", async () => {
  const { models, prompts } = modelsReplying([replyGrouping(eightFiles)]);

  await groupDiff({ files: eightFiles, config: config(), intents: [], models });

  assert.doesNotMatch(prompts[0] ?? "", /last round/i);
});

test("a small diff still reaches the model, so it is never served alphabetically", async () => {
  const files = eightFiles.slice(0, 3);
  const { models, prompts } = modelsReplying([replyGrouping(files)]);

  const result = await groupDiff({ files, config: config(), intents: [], models });

  assert.equal(result.mode, "llm");
  assert.equal(prompts.length, 1);
});

test("a provider that was never configured fails the review instead of degrading", async () => {
  // Other model failures degrade to one group (a review beats none). This one is setup, not
  // weather: silently reviewing ungrouped would hide that the model was never called.
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Provider is not configured: anthropic",
    }),
  ]);

  await assert.rejects(
    () => groupDiff({ files: eightFiles, config: config(), intents: [], models }),
    (error: unknown) => error instanceof ReviewError && error.code === "pi_auth_missing",
  );
});

/**
 * The reviewer meets this rationale on the ordinary one-file review, so it obeys the prompt's
 * rule: a statement about the change, not a question.
 */
test("the All Changes rationale says what happened to the diff, and asks nothing", async () => {
  const result = await groupDiff({
    files: [diffFile("src/a.ts")],
    config: config(),
    intents: [],
    models: modelsReplying([]).models,
  });

  assert.equal(result.groups[0]?.rationale, UNGROUPED_RATIONALE);
  assert.doesNotMatch(UNGROUPED_RATIONALE, /\?/);
  assert.match(UNGROUPED_RATIONALE, /order git listed them/i);
});

test("every rejected attempt says why on stderr, so a fallback is diagnosable", async () => {
  const spoken: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => void spoken.push(String(line));
  try {
    await groupDiff({
      files: eightFiles.slice(0, 2),
      intents: [],
      config: config(),
      models: modelsReplying(["not json at all", "still not json", "nope"]).models,
    });
  } finally {
    console.error = original;
  }
  assert.equal(spoken.length, 3);
  assert.match(spoken[0] ?? "", /grouping attempt 1 rejected: your reply is not valid JSON/);
  assert.match(spoken[2] ?? "", /grouping attempt 3 rejected/);
});
