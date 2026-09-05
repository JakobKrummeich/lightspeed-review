import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewError } from "../../src/errors.ts";
import {
  buildAgentReplyRecord,
  buildAnnotationRecord,
  buildMessageRecord,
  buildOutcomeRecord,
  buildRoundFileRecord,
  type ContextFields,
  type LedgerRecord,
  type RepoRef,
} from "../../src/ledger/records.ts";
import {
  parseSince,
  renderItems,
  repoRows,
  selectItems,
  verdictCounts,
  type ExportItem,
} from "../../src/ledger/export.ts";

const repo: RepoRef = { root: "/home/dev/app", name: "app", remote: "github.com/acme/app" };
const other: RepoRef = { root: "/home/dev/other", name: "other", remote: null };

interface AnnotationOptions {
  id: string;
  at: string;
  round?: string;
  repo?: RepoRef;
  file?: string;
  comment?: string;
  selected?: string;
  context?: string;
  /** Set when the reviewer marked part of a line rather than whole lines. */
  columns?: { col_start?: number; col_end?: number };
}

function annotation(options: AnnotationOptions): LedgerRecord {
  const context: ContextFields =
    options.context === undefined ? {} : { context: options.context, context_source: "anchor" };
  return buildAnnotationRecord({
    id: options.id,
    at: options.at,
    round: options.round ?? "rnd_1",
    repo: options.repo ?? repo,
    branch: "feat/ledger",
    base: "main",
    base_commit: "a1b2c3d",
    head_commit: "9f8e7d6",
    file: options.file ?? "src/server.ts",
    previous_path: null,
    file_status: "modified",
    group: "Ledger write path",
    blob_new: null,
    blob_old: null,
    line_start: 214,
    line_end: 219,
    side: "new",
    ...options.columns,
    selected_text: options.selected ?? "if (!ok) throw new Error()",
    comment: options.comment ?? "Return a ReviewError instead",
    ...context,
  });
}

function roundFile(file: string, patch: string, round = "rnd_1"): LedgerRecord {
  return buildRoundFileRecord({
    id: `evt_rf_${file}`,
    at: "2026-02-14T09:00:00.000Z",
    round,
    repo,
    file,
    previous_path: null,
    file_status: "modified",
    group: "Ledger write path",
    blob_new: "4c9f88d",
    blob_old: "11ab34c",
    patch,
    approval: "unapproved",
    first_seen_round: 0,
  });
}

function outcome(about: string, verdict: "addressed" | "ignored" | "repeated" | "unknown") {
  return buildOutcomeRecord({
    id: `evt_out_${about}`,
    at: "2026-02-15T09:00:00.000Z",
    repo,
    about,
    next_round: "rnd_2",
    from_commit: "9f8e7d6",
    to_commit: "5b4a392",
    file_touched: verdict === "addressed",
    response_patch: "@@ -214,6 +214,8 @@ fixed",
    re_annotated: verdict === "repeated",
    approved: verdict === "addressed",
    verdict,
  });
}

function ids(items: ExportItem[]): string[] {
  return items.map((item) => item.id);
}

function jsonlText(items: ExportItem[], maxBytes?: number): string {
  const rendered = renderItems(items, {
    format: "jsonl",
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return rendered.format === "jsonl" ? rendered.text : "";
}

/**
 * Slice 1 wrote annotations with no line anchor, context or `truncated` list.
 * Still `schema: 1`, so every field added since is optional at read time.
 */
test("an annotation written before later fields existed still reads and renders", () => {
  const beforeAnchors = {
    schema: 1,
    id: "evt_1",
    at: "2026-01-04T09:00:00.000Z",
    kind: "annotation",
    round: "rnd_1",
    repo,
    branch: "feat/ledger",
    base: "main",
    base_commit: "a1b2c3d",
    head_commit: "9f8e7d6",
    file: "src/server.ts",
    previous_path: null,
    file_status: "modified",
    group: "Ledger write path",
    blob_new: null,
    blob_old: null,
    selected_text: "if (!ok) throw new Error()",
    comment: "Return a ReviewError instead",
  } as unknown as LedgerRecord;

  const [item] = selectItems([beforeAnchors], {}).items;
  const rendered = renderItems([item!], { format: "toon", withPatches: true });

  assert.partialDeepStrictEqual(item, {
    id: "evt_1",
    comment: "Return a ReviewError instead",
    verdict: "unknown",
    truncated: [],
  });
  assert.equal(item?.side, undefined);
  assert.equal(item?.context, undefined);
  assert.equal(rendered.included, 1);
  assert.equal(rendered.truncated, 0);
  assert.match(jsonlText([item!]), /Return a ReviewError instead/);
});

test("an annotation becomes one self-contained item carrying its round file's patch", () => {
  const records = [
    roundFile("src/server.ts", "@@ -1 +1 @@\n-old\n+new"),
    annotation({ id: "evt_1", at: "2026-02-14T09:31:02.118Z" }),
  ];

  const [item] = selectItems(records, {}).items;

  assert.equal(item?.id, "evt_1");
  assert.equal(item?.file, "src/server.ts");
  assert.equal(item?.comment, "Return a ReviewError instead");
  assert.equal(item?.selected_text, "if (!ok) throw new Error()");
  assert.equal(item?.patch, "@@ -1 +1 @@\n-old\n+new");
  assert.equal(item?.repo.root, "/home/dev/app");
  assert.equal(item?.branch, "feat/ledger");
  assert.equal(item?.head_commit, "9f8e7d6");
  assert.equal(item?.line_start, 214);
  assert.equal(item?.side, "new");
});

test("blob shas of the round file fill in what the annotation did not know", () => {
  const records = [
    roundFile("src/server.ts", "@@ -1 +1 @@"),
    annotation({ id: "evt_1", at: "2026-02-14T09:31:02.118Z" }),
  ];

  const [item] = selectItems(records, {}).items;

  assert.equal(item?.blob_new, "4c9f88d");
  assert.equal(item?.blob_old, "11ab34c");
});

test("an annotation whose round file is missing still yields an item without a patch", () => {
  const records = [annotation({ id: "evt_1", at: "2026-02-14T09:31:02.118Z" })];

  const [item] = selectItems(records, {}).items;

  assert.equal(item?.id, "evt_1");
  assert.equal(item?.patch, undefined);
});

test("a round file of another round never lends its patch", () => {
  const records = [
    roundFile("src/server.ts", "@@ round two @@", "rnd_2"),
    annotation({ id: "evt_1", at: "2026-02-14T09:31:02.118Z", round: "rnd_1" }),
  ];

  const [item] = selectItems(records, {}).items;

  assert.equal(item?.patch, undefined);
});

test("an outcome about the annotation supplies the verdict and the response patch", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:31:02.118Z" }),
    outcome("evt_1", "addressed"),
  ];

  const [item] = selectItems(records, {}).items;

  assert.equal(item?.verdict, "addressed");
  assert.equal(item?.outcome?.next_round, "rnd_2");
  assert.equal(item?.outcome?.to_commit, "5b4a392");
  assert.equal(item?.outcome?.approved, true);
  assert.equal(item?.outcome?.response_patch, "@@ -214,6 +214,8 @@ fixed");
});

test("an annotation nothing judged yet is unknown with no outcome block", () => {
  const [item] = selectItems(
    [annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" })],
    {},
  ).items;

  assert.equal(item?.verdict, "unknown");
  assert.equal(item?.outcome, undefined);
});

test("messages, agent replies and round records are not items", () => {
  const records = [
    buildMessageRecord({
      id: "evt_m",
      at: "2026-02-14T09:00:00.000Z",
      round: "rnd_1",
      repo,
      branch: "b",
      base: "main",
      comment: "general",
    }),
    buildAgentReplyRecord({
      id: "evt_r",
      at: "2026-02-14T09:00:01.000Z",
      round: "rnd_1",
      repo,
      branch: "b",
      base: "main",
      comment: "done",
    }),
    annotation({ id: "evt_1", at: "2026-02-14T09:00:02.000Z" }),
  ];

  assert.deepEqual(ids(selectItems(records, {}).items), ["evt_1"]);
});

test("items come out oldest first so a slice reads as a transcript", () => {
  const records = [
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
  ];

  assert.deepEqual(ids(selectItems(records, {}).items), ["evt_1", "evt_2"]);
});

test("repo filters on the repository root, not the name", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z", repo: other }),
  ];

  assert.deepEqual(ids(selectItems(records, { repo: "/home/dev/other" }).items), ["evt_2"]);
});

test("since keeps items at or after the timestamp", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
  ];

  assert.deepEqual(ids(selectItems(records, { since: "2026-02-14T10:00:00.000Z" }).items), [
    "evt_2",
  ]);
});

test("cursor resumes strictly after the last id the caller saw", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
  ];

  assert.deepEqual(ids(selectItems(records, { cursor: "evt_1" }).items), ["evt_2"]);
});

test("verdict filters on the joined outcome", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
    outcome("evt_1", "repeated"),
    outcome("evt_2", "addressed"),
  ];

  assert.deepEqual(ids(selectItems(records, { verdict: "repeated" }).items), ["evt_1"]);
});

test("file matches an exact path or a directory prefix", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z", file: "src/ledger/store.ts" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z", file: "src/server.ts" }),
  ];

  assert.deepEqual(ids(selectItems(records, { file: "src/server.ts" }).items), ["evt_2"]);
  assert.deepEqual(ids(selectItems(records, { file: "src/ledger" }).items), ["evt_1"]);
  assert.deepEqual(ids(selectItems(records, { file: "src/serv" }).items), []);
});

test("limit takes the oldest matches and reports the total and the resume cursor", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
    annotation({ id: "evt_3", at: "2026-02-14T11:00:00.000Z" }),
  ];

  const result = selectItems(records, { limit: 2 });

  assert.deepEqual(ids(result.items), ["evt_1", "evt_2"]);
  assert.equal(result.matched, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.cursor, "evt_2");
});

test("an exported item says where its context came from, or carries none at all", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z", context: "around the line" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
  ];

  const [withContext, without] = selectItems(records, {}).items;

  assert.equal(withContext?.context, "around the line");
  assert.equal(withContext?.context_source, "anchor");
  assert.equal(without && "context" in without, false);
  assert.equal(without && "context_source" in without, false);
});

test("an empty selection is a definitive zero, not an absent cursor bug", () => {
  const result = selectItems([], {});

  assert.deepEqual(result, { items: [], matched: 0, hasMore: false, cursor: undefined });
});

test("verdictCounts precomputes the aggregate a summary would otherwise sum", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
    annotation({ id: "evt_3", at: "2026-02-14T11:00:00.000Z" }),
    outcome("evt_1", "repeated"),
    outcome("evt_2", "addressed"),
  ];

  const counts = verdictCounts(selectItems(records, {}).items);

  assert.deepEqual(counts, {
    addressed: 1,
    ignored: 0,
    repeated: 1,
    unknown: 1,
    unresolved: 1,
  });
});

test("repoRows buckets items per repository, sorted by name, with verdict counts", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z", repo: other }),
    annotation({ id: "evt_3", at: "2026-02-14T11:00:00.000Z" }),
    outcome("evt_1", "addressed"),
  ];

  const rows = repoRows(selectItems(records, {}).items);

  assert.deepEqual(rows, [
    { name: "app", root: repo.root, items: 2, addressed: 1, ignored: 0, repeated: 0, unknown: 1 },
    {
      name: "other",
      root: other.root,
      items: 1,
      addressed: 0,
      ignored: 0,
      repeated: 0,
      unknown: 1,
    },
  ]);
});

/**
 * Counts are keyed by verdict, so one off the list would invent a NaN column.
 * Quietly wrong is worse than failing, and the ledger is hand-editable.
 */
test("a verdict the ledger does not define reads as unknown", () => {
  const bogus = { ...outcome("evt_1", "addressed"), verdict: "gossip" } as unknown as LedgerRecord;
  const records = [annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }), bogus];

  const items = selectItems(records, {}).items;

  assert.equal(items[0]?.verdict, "unknown");
  assert.deepEqual(verdictCounts(items), {
    addressed: 0,
    ignored: 0,
    repeated: 0,
    unknown: 1,
    unresolved: 0,
  });
});

test("a verdict filter still matches an item an unknown verdict fell back to", () => {
  const bogus = { ...outcome("evt_1", "addressed"), verdict: "gossip" } as unknown as LedgerRecord;
  const records = [annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }), bogus];

  assert.deepEqual(ids(selectItems(records, { verdict: "unknown" }).items), ["evt_1"]);
});

test("toon rendering hands back the item objects and its exact byte size", () => {
  const items = selectItems(
    [annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" })],
    {},
  ).items;

  const rendered = renderItems(items, { format: "toon" });

  assert.equal(rendered.format, "toon");
  assert.equal(rendered.format === "toon" ? rendered.items.length : 0, 1);
  assert.equal(rendered.included, 1);
  assert.equal(rendered.omitted, 0);
  assert.ok(rendered.bytes > 0);
});

test("a render with no items reports zero bytes, not the bytes of an empty table", () => {
  const rendered = renderItems([], { format: "toon" });

  assert.equal(rendered.included, 0);
  assert.equal(rendered.bytes, 0);
});

test("patches are omitted unless asked for, and the omission is marked", () => {
  const records = [
    roundFile("src/server.ts", "@@ -1 +1 @@\n-old\n+new"),
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    outcome("evt_1", "addressed"),
  ];
  const items = selectItems(records, {}).items;

  const rendered = renderItems(items, { format: "toon" });
  const [item] = rendered.format === "toon" ? rendered.items : [];

  assert.equal(item?.patch, undefined);
  assert.equal(item?.outcome?.response_patch, undefined);
  assert.equal(item?.patch_omitted, true);
});

test("code context goes with the patches, and that omission is marked too", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z", context: "around the line" }),
  ];
  const items = selectItems(records, {}).items;

  const rendered = renderItems(items, { format: "toon" });
  const [item] = rendered.format === "toon" ? rendered.items : [];

  assert.equal(item?.context, undefined);
  assert.equal(item?.context_source, undefined);
  assert.equal(item?.context_omitted, true);
});

test("withPatches keeps both the round patch and the response patch", () => {
  const records = [
    roundFile("src/server.ts", "@@ -1 +1 @@\n-old\n+new"),
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    outcome("evt_1", "addressed"),
  ];
  const items = selectItems(records, {}).items;

  const rendered = renderItems(items, { format: "toon", withPatches: true });
  const [item] = rendered.format === "toon" ? rendered.items : [];

  assert.equal(item?.patch, "@@ -1 +1 @@\n-old\n+new");
  assert.equal(item?.outcome?.response_patch, "@@ -214,6 +214,8 @@ fixed");
  assert.equal(item?.patch_omitted, undefined);
});

test("withPatches is the one switch that keeps the code context as well", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z", context: "around the line" }),
  ];
  const items = selectItems(records, {}).items;

  const rendered = renderItems(items, { format: "toon", withPatches: true });
  const [item] = rendered.format === "toon" ? rendered.items : [];

  assert.equal(item?.context, "around the line");
  assert.equal(item?.context_source, "anchor");
  assert.equal(item?.context_omitted, undefined);
});

test("an item with no patch or context is not marked as having either omitted", () => {
  const items = selectItems(
    [annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" })],
    {},
  ).items;

  const rendered = renderItems(items, { format: "toon" });
  const [item] = rendered.format === "toon" ? rendered.items : [];

  assert.equal(item?.patch_omitted, undefined);
  assert.equal(item?.context_omitted, undefined);
});

test("jsonl rendering is one parseable object per line", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
  ];
  const items = selectItems(records, {}).items;

  const rendered = renderItems(items, { format: "jsonl" });
  const text = rendered.format === "jsonl" ? rendered.text : "";
  const lines = text.trimEnd().split("\n");

  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { id: string }).id),
    ["evt_1", "evt_2"],
  );
  assert.equal(text.endsWith("\n"), true);
  assert.equal(rendered.bytes, Buffer.byteLength(text));
});

test("markdown rendering carries path, comment and the selected code verbatim", () => {
  const items = selectItems(
    [
      roundFile("src/server.ts", "@@ -1 +1 @@"),
      annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    ],
    {},
  ).items;

  const rendered = renderItems(items, { format: "md" });
  const text = rendered.format === "md" ? rendered.text : "";

  assert.match(text, /evt_1/);
  assert.match(text, /src\/server\.ts/);
  assert.match(text, /Return a ReviewError instead/);
  assert.match(text, /if \(!ok\) throw new Error\(\)/);
  assert.match(text, /214-219/);
});

test("a clipped selection renders its columns, so the range names the characters", () => {
  const items = selectItems(
    [
      annotation({
        id: "evt_1",
        at: "2026-02-14T09:00:00.000Z",
        columns: { col_start: 9, col_end: 21 },
      }),
    ],
    {},
  ).items;

  const rendered = renderItems(items, { format: "md" });
  const text = rendered.format === "md" ? rendered.text : "";

  assert.match(text, /214:9-219:21 \(new\)/);
  assert.equal(items[0]?.col_start, 9);
});

test("a boundary line taken whole renders without a column on that end", () => {
  const items = selectItems(
    [annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z", columns: { col_end: 21 } })],
    {},
  ).items;

  const rendered = renderItems(items, { format: "md" });
  const text = rendered.format === "md" ? rendered.text : "";

  assert.match(text, /214-219:21 \(new\)/);
});

test("maxBytes drops whole items from the newest end and counts the omission", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
    annotation({ id: "evt_3", at: "2026-02-14T11:00:00.000Z" }),
  ];
  const items = selectItems(records, {}).items;
  const oneItem = Buffer.byteLength(jsonlText(items.slice(0, 1)));

  const rendered = renderItems(items, { format: "jsonl", maxBytes: oneItem * 2 });
  const text = rendered.format === "jsonl" ? rendered.text : "";

  assert.deepEqual(
    text
      .trimEnd()
      .split("\n")
      .map((line) => (JSON.parse(line) as { id: string }).id),
    ["evt_1", "evt_2"],
  );
  assert.equal(rendered.included, 2);
  assert.equal(rendered.omitted, 1);
  assert.equal(rendered.cursor, "evt_2");
  assert.ok(rendered.bytes <= oneItem * 2);
});

test("a budget too small for even one item yields nothing rather than half a record", () => {
  const items = selectItems(
    [annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z" })],
    {},
  ).items;

  const rendered = renderItems(items, { format: "jsonl", maxBytes: 10 });

  assert.equal(rendered.format === "jsonl" ? rendered.text : "x", "");
  assert.equal(rendered.included, 0);
  assert.equal(rendered.omitted, 1);
  assert.equal(rendered.cursor, undefined);
});

test("the truncated count reports how many items carry a capped field", () => {
  const records = [
    annotation({ id: "evt_1", at: "2026-02-14T09:00:00.000Z", comment: "x".repeat(20_000) }),
    annotation({ id: "evt_2", at: "2026-02-14T10:00:00.000Z" }),
  ];
  const items = selectItems(records, {}).items;

  assert.deepEqual(items[0]?.truncated, ["comment"]);
  assert.equal(renderItems(items, { format: "jsonl" }).truncated, 1);
});

test("parseSince accepts a plain date, a full timestamp and a duration", () => {
  const now = new Date("2026-02-14T09:00:00.000Z");

  assert.equal(parseSince("2026-01-04", now), "2026-01-04T00:00:00.000Z");
  assert.equal(parseSince("2026-01-04T10:11:12.000Z", now), "2026-01-04T10:11:12.000Z");
  assert.equal(parseSince("30d", now), "2026-01-15T09:00:00.000Z");
  assert.equal(parseSince("12h", now), "2026-02-13T21:00:00.000Z");
  assert.equal(parseSince("2w", now), "2026-01-31T09:00:00.000Z");
});

test("an unparseable since is a structured invalid_arguments error", () => {
  assert.throws(
    () => parseSince("last tuesday"),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "invalid_arguments" &&
      error.suggestions.length > 0,
  );
});
