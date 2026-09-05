import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_CAPS,
  LEDGER_KINDS,
  buildAgentReplyRecord,
  buildAnnotationRecord,
  buildDeclarationRecord,
  buildMessageRecord,
  buildOutcomeRecord,
  buildRoundEndRecord,
  buildRoundFileRecord,
  buildRoundRecord,
  createIdSource,
  type AnchorFields,
  type LedgerKind,
  type LedgerRecord,
} from "../../src/ledger/records.ts";
import type { AnchorFields as PromptAnchorFields } from "../../src/session-store.ts";

const repo = { root: "/home/dev/app", name: "app", remote: "github.com/o/app" };

const roundInput = {
  id: "evt_1",
  at: "2026-02-14T09:30:00.000Z",
  round: "rnd_1",
  repo,
  branch: "feat/ledger",
  base: "main",
  base_commit: "a1b2c3d",
  head_commit: "9f8e7d6",
  stats: { files_changed: 2, insertions: 10, deletions: 3, binary_skipped: 0 },
  groups: ["Write path", "Tests"],
};

const fileInput = {
  id: "evt_2",
  at: "2026-02-14T09:30:01.000Z",
  round: "rnd_1",
  repo,
  file: "src/server.ts",
  previous_path: null,
  file_status: "modified" as const,
  group: "Write path",
  blob_new: "4c9f",
  blob_old: "11ab",
  patch: "@@ -1,2 +1,3 @@\n+added",
  approval: "unapproved" as const,
  first_seen_round: 0,
};

const annotationInput = {
  id: "evt_3",
  at: "2026-02-14T09:31:02.118Z",
  round: "rnd_1",
  repo,
  branch: "feat/ledger",
  base: "main",
  base_commit: "a1b2c3d",
  head_commit: "9f8e7d6",
  file: "src/server.ts",
  previous_path: null,
  file_status: "modified" as const,
  group: "Write path",
  blob_new: "4c9f",
  blob_old: "11ab",
  selected_text: "+  if (!ok) throw new Error()",
  comment: "Return a ReviewError instead",
};

test("a round record is schema 1 and carries every field it was given", () => {
  const record = buildRoundRecord(roundInput);

  assert.deepEqual(record, {
    schema: 1,
    id: "evt_1",
    at: "2026-02-14T09:30:00.000Z",
    kind: "round",
    round: "rnd_1",
    repo,
    branch: "feat/ledger",
    base: "main",
    base_commit: "a1b2c3d",
    head_commit: "9f8e7d6",
    stats: { files_changed: 2, insertions: 10, deletions: 3, binary_skipped: 0 },
    groups: ["Write path", "Tests"],
  });
});

test("a round-file record carries the rename source, blobs and patch", () => {
  const record = buildRoundFileRecord({
    ...fileInput,
    previous_path: "src/old.ts",
    file_status: "renamed",
  });

  assert.equal(record.kind, "round_file");
  assert.equal(record.approval, "unapproved");
  assert.equal(record.previous_path, "src/old.ts");
  assert.equal(record.file_status, "renamed");
  assert.equal(record.blob_old, "11ab");
  assert.equal(record.patch, "@@ -1,2 +1,3 @@\n+added");
  assert.deepEqual(record.truncated, []);
});

test("an annotation record carries the comment, selection and round anchors", () => {
  const record = buildAnnotationRecord({
    ...annotationInput,
    context: "line\nline",
    context_source: "search",
  });

  assert.equal(record.kind, "annotation");
  assert.equal(record.comment, "Return a ReviewError instead");
  assert.equal(record.selected_text, "+  if (!ok) throw new Error()");
  assert.equal(record.context, "line\nline");
  assert.equal(record.context_source, "search");
  assert.equal(record.head_commit, "9f8e7d6");
  assert.deepEqual(record.truncated, []);
});

test("an annotation omits line anchors that were not captured", () => {
  const record = buildAnnotationRecord(annotationInput);

  assert.equal("line_start" in record, false);
  assert.equal("line_end" in record, false);
  assert.equal("side" in record, false);
  assert.equal("context" in record, false);
  assert.equal("context_source" in record, false);
});

test("an annotation keeps the line anchors it was given", () => {
  const record = buildAnnotationRecord({
    ...annotationInput,
    line_start: 214,
    line_end: 219,
    side: "new",
  });

  assert.equal(record.line_start, 214);
  assert.equal(record.line_end, 219);
  assert.equal(record.side, "new");
  assert.equal("col_start" in record, false);
  assert.equal("col_end" in record, false);
});

test("an annotation keeps the columns of a selection that clipped a line", () => {
  const record = buildAnnotationRecord({
    ...annotationInput,
    line_start: 214,
    line_end: 214,
    side: "new",
    col_start: 9,
    col_end: 21,
  });

  assert.equal(record.col_start, 9);
  assert.equal(record.col_end, 21);
});

test("a message record and an agent reply record differ only by kind", () => {
  const input = {
    id: "evt_4",
    at: "2026-02-14T09:32:00.000Z",
    round: "rnd_1",
    repo,
    branch: "feat/ledger",
    base: "main",
    comment: "General note",
  };

  assert.equal(buildMessageRecord(input).kind, "message");
  assert.equal(buildAgentReplyRecord(input).kind, "agent_reply");
  assert.equal(buildAgentReplyRecord(input).comment, "General note");
});

test("a round-end record keeps this round's approvals apart from the carried ones", () => {
  const record = buildRoundEndRecord({
    id: "evt_5",
    at: "2026-02-14T10:00:00.000Z",
    round: "rnd_1",
    repo,
    branch: "feat/ledger",
    base: "main",
    approved: ["src/server.ts"],
    carried: ["src/store.ts"],
  });

  assert.equal(record.kind, "round_end");
  assert.deepEqual(record.approved, ["src/server.ts"]);
  assert.deepEqual(record.carried, ["src/store.ts"]);
});

test("a round-file record says where the file stood with the reviewer", () => {
  const record = buildRoundFileRecord({ ...fileInput, approval: "approved" });

  assert.equal(record.approval, "approved");
});

test("a round-file record says which round the file entered the review in", () => {
  const record = buildRoundFileRecord({ ...fileInput, first_seen_round: 2 });

  assert.equal(record.first_seen_round, 2);
});

test("an outcome record labels the annotation it is about", () => {
  const record = buildOutcomeRecord({
    id: "evt_6",
    at: "2026-02-14T10:02:44.901Z",
    repo,
    about: "evt_3",
    next_round: "rnd_2",
    from_commit: "9f8e7d6",
    to_commit: "5b4a392",
    file_touched: true,
    response_patch: "@@ -214,6 +214,8 @@",
    re_annotated: false,
    approved: true,
    verdict: "addressed",
  });

  assert.equal(record.kind, "outcome");
  assert.equal(record.about, "evt_3");
  assert.equal(record.verdict, "addressed");
  assert.equal(record.response_patch, "@@ -214,6 +214,8 @@");
});

test("every ledger kind has a builder", () => {
  const built: LedgerRecord[] = [
    buildRoundRecord(roundInput),
    buildRoundFileRecord(fileInput),
    buildAnnotationRecord(annotationInput),
    buildMessageRecord({ ...annotationInput }),
    buildAgentReplyRecord({ ...annotationInput }),
    buildDeclarationRecord({
      ...annotationInput,
      about: "evt_3",
      files: ["src/server.ts"],
    }),
    buildRoundEndRecord({ ...annotationInput, approved: [], carried: [] }),
    buildOutcomeRecord({
      id: "evt_6",
      at: "2026-02-14T10:02:44.901Z",
      repo,
      about: "evt_3",
      next_round: "rnd_2",
      from_commit: "9f8e7d6",
      to_commit: "5b4a392",
      file_touched: false,
      re_annotated: false,
      approved: false,
      verdict: "unknown",
    }),
  ];

  const kinds = built.map((record) => record.kind);
  assert.deepEqual([...kinds].sort(), [...LEDGER_KINDS].sort());
  assert.equal(new Set(kinds).size, LEDGER_KINDS.length);
});

test("a declaration record names the annotation it answers and the files it led to", () => {
  const record = buildDeclarationRecord({
    ...annotationInput,
    about: "evt_3",
    files: ["src/server.ts", "src/store.ts"],
    note: "split into two commits",
  });

  assert.equal(record.kind, "declaration");
  assert.equal(record.about, "evt_3");
  assert.deepEqual(record.files, ["src/server.ts", "src/store.ts"]);
  assert.equal(record.note, "split into two commits");
  assert.deepEqual(record.truncated, []);
});

test("a declaration without a note leaves the field out entirely", () => {
  const record = buildDeclarationRecord({ ...annotationInput, about: "evt_3", files: [] });

  assert.equal("note" in record, false);
});

test("an over-long declaration note is cut to its cap and marked truncated", () => {
  const record = buildDeclarationRecord({
    ...annotationInput,
    about: "evt_3",
    files: [],
    note: "n".repeat(20_000),
  });

  assert.equal(Buffer.byteLength(record.note ?? ""), FIELD_CAPS.note.bytes);
  assert.deepEqual(record.truncated, ["note"]);
});

test("every record is stamped schema 1", () => {
  assert.equal(buildRoundFileRecord(fileInput).schema, 1);
  assert.equal(buildAnnotationRecord(annotationInput).schema, 1);
});

test("an over-long comment is cut to its cap and marked truncated", () => {
  const record = buildAnnotationRecord({ ...annotationInput, comment: "x".repeat(20_000) });

  assert.equal(Buffer.byteLength(record.comment), FIELD_CAPS.comment.bytes);
  assert.deepEqual(record.truncated, ["comment"]);
});

test("selection and context have their own caps and are marked independently", () => {
  const record = buildAnnotationRecord({
    ...annotationInput,
    selected_text: "s".repeat(5000),
    context: "c".repeat(9000),
    context_source: "anchor" as const,
  });

  assert.equal(Buffer.byteLength(record.selected_text), FIELD_CAPS.selected_text.bytes);
  assert.equal(Buffer.byteLength(record.context ?? ""), FIELD_CAPS.context.bytes);
  assert.deepEqual([...record.truncated].sort(), ["context", "selected_text"]);
});

test("a patch is capped by bytes", () => {
  const record = buildRoundFileRecord({ ...fileInput, patch: "p".repeat(70_000) });

  assert.equal(Buffer.byteLength(record.patch), FIELD_CAPS.patch.bytes);
  assert.deepEqual(record.truncated, ["patch"]);
});

test("a patch is capped by line count as well as bytes", () => {
  const record = buildRoundFileRecord({ ...fileInput, patch: "+a\n".repeat(3000) });

  assert.equal(record.patch.split("\n").length, FIELD_CAPS.patch.lines);
  assert.deepEqual(record.truncated, ["patch"]);
});

test("a response patch is capped like a patch", () => {
  const record = buildOutcomeRecord({
    id: "evt_6",
    at: "2026-02-14T10:02:44.901Z",
    repo,
    about: "evt_3",
    next_round: "rnd_2",
    from_commit: "a",
    to_commit: "b",
    file_touched: true,
    response_patch: "r".repeat(70_000),
    re_annotated: false,
    approved: false,
    verdict: "repeated",
  });

  assert.equal(Buffer.byteLength(record.response_patch ?? ""), FIELD_CAPS.patch.bytes);
  assert.deepEqual(record.truncated, ["response_patch"]);
});

test("capping never leaves a broken multi-byte character behind", () => {
  const record = buildAnnotationRecord({ ...annotationInput, comment: "ü".repeat(20_000) });

  assert.equal(record.comment.includes("\uFFFD"), false);
  assert.ok(Buffer.byteLength(record.comment) <= FIELD_CAPS.comment.bytes);
});

test("a field at exactly its cap is not marked truncated", () => {
  const record = buildAnnotationRecord({
    ...annotationInput,
    comment: "x".repeat(FIELD_CAPS.comment.bytes),
  });

  assert.deepEqual(record.truncated, []);
});

test("an id is prefixed, stamped and sequenced", () => {
  const id = createIdSource()("evt", "2026-02-14T09:31:02.118Z");

  assert.match(id, /^evt_[0-9a-z]{9}_[0-9a-f]{4}$/);
});

test("ids sort chronologically as plain strings", () => {
  const nextId = createIdSource();
  const ids = [
    nextId("evt", "2026-02-14T09:31:02.118Z"),
    nextId("evt", "2026-02-14T09:31:02.119Z"),
    nextId("evt", "2027-01-01T00:00:00.000Z"),
    nextId("evt", "2100-01-01T00:00:00.000Z"),
  ];

  assert.deepEqual([...ids].sort(), ids);
});

test("the round prefix is honoured", () => {
  assert.match(createIdSource()("rnd", "2026-02-14T09:31:02.118Z"), /^rnd_/);
});

test("an unparseable timestamp still yields an id", () => {
  assert.match(createIdSource()("evt", "not-a-date"), /^evt_[0-9a-z]{9}_[0-9a-f]{4}$/);
});

/**
 * The anchor is declared once per wire schema so neither side imports the other.
 * `write.ts` spreads one into the other; these assignments fail typecheck on drift.
 */
test("the prompt anchor and the ledger anchor are the same shape", () => {
  // Identical types, not merely assignable ones: an extra field on one side is
  // assignable to the other and would slip through a plain assignment check.
  type Identical<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  const anchorsAgree: Identical<AnchorFields, PromptAnchorFields> = true;

  assert.equal(anchorsAgree, true);
});

/**
 * Ordering is a property of one writer, not of this module: the server holds a
 * single source, and a test or a second writer cannot shift its numbering.
 */
test("each id source counts on its own", () => {
  const one = createIdSource();
  const other = createIdSource();

  assert.equal(one("evt", "2026-02-14T09:31:02.118Z"), other("evt", "2026-02-14T09:31:02.118Z"));
});

/** The documented limit of a 16-bit sequence, pinned so it cannot surprise. */
test("the sequence wraps after 65536 ids in the same millisecond", () => {
  const nextId = createIdSource();
  const first = nextId("evt", "2026-02-14T09:31:02.118Z");
  for (let made = 1; made < 0x10000; made += 1) nextId("evt", "2026-02-14T09:31:02.118Z");

  assert.equal(nextId("evt", "2026-02-14T09:31:02.118Z"), first);
});

test("the kind list is the discriminated union's tags", () => {
  const kinds: readonly LedgerKind[] = LEDGER_KINDS;

  assert.deepEqual(
    [...kinds].sort(),
    [
      "agent_reply",
      "annotation",
      "declaration",
      "message",
      "outcome",
      "round",
      "round_end",
      "round_file",
    ].sort(),
  );
});

test("ids made in the same millisecond stay in the order they were produced", () => {
  const nextId = createIdSource();
  const first = nextId("evt", "2026-02-14T09:31:02.118Z");
  const second = nextId("evt", "2026-02-14T09:31:02.118Z");
  const third = nextId("evt", "2026-02-14T09:31:02.118Z");

  assert.deepEqual([first, second, third].sort(), [first, second, third]);
  assert.equal(new Set([first, second, third]).size, 3);
});
