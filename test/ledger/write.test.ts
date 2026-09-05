import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiffFile } from "../../src/diff-extract.ts";
import { LedgerStore } from "../../src/ledger/store.ts";
import {
  createIdSource,
  type AnnotationRecord,
  type RoundFileRecord,
  type RoundRecord,
} from "../../src/ledger/records.ts";
import type { AnnotationSide } from "../../src/ledger/records.ts";
import {
  agentReplyRecords,
  declarationRecords,
  feedbackRecords,
  type ReadSideFile,
  recordSafely,
  roundEndRecords,
  roundRecords,
} from "../../src/ledger/write.ts";
import type { SessionRecord } from "../../src/session-store.ts";

/** Every test writes through one source, as the server does. */
const nextId = createIdSource();

/** Stands for git having no version to read: binary, oversized or deleted. */
const noFile: ReadSideFile = () => undefined;

/**
 * The two versions of `src/server.ts` a reader would hand back, distinguishable
 * so a test can tell which side the slicer was pointed at.
 */
const versions: Record<AnnotationSide, string> = {
  old: ["before one", "before two", "old marker", "before four"].join("\n"),
  new: ["after one", "after two", "new marker", "after four"].join("\n"),
};

const readVersion: ReadSideFile = (path, side) =>
  path === "src/server.ts" ? versions[side] : undefined;

const NOW = "2026-02-14T09:00:00.000Z";
const repo = { root: "/home/dev/app", name: "app", remote: "github.com/o/app" };

const changed: DiffFile = {
  path: "src/server.ts",
  status: "modified",
  diff: [
    "diff --git a/src/server.ts b/src/server.ts",
    "index 11ab34c..4c9f88d 100644",
    "--- a/src/server.ts",
    "+++ b/src/server.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n"),
  insertions: 1,
  deletions: 1,
  oversized: false,
};

const binary: DiffFile = {
  path: "logo.png",
  status: "binary",
  diff: "",
  insertions: 0,
  deletions: 0,
  oversized: false,
};

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    key: "k1",
    repoRoot: "/home/dev/app",
    branch: "feat/ledger",
    base: "main",
    baseCommit: "a1b2c3d",
    headCommit: "9f8e7d6",
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
    groups: [{ name: "Write path", rationale: "server hooks", files: [changed, binary] }],
    conversation: [],
    pending: [],
    approved: [],
    rounds: [],
    round: "rnd_1",
    ...overrides,
  };
}

function newStore(): LedgerStore {
  return new LedgerStore(join(mkdtempSync(join(tmpdir(), "lsr-write-")), "feedback"));
}

function unwritableStore(): LedgerStore {
  const blocker = join(mkdtempSync(join(tmpdir(), "lsr-write-")), "blocker");
  writeFileSync(blocker, "not a directory");
  return new LedgerStore(join(blocker, "feedback"));
}

test("a round writes one round record with precomputed stats and group names", () => {
  const [round] = roundRecords({ round: "rnd_1", session: session(), repo, now: NOW, nextId });

  assert.deepEqual(round, {
    schema: 1,
    id: (round as RoundRecord).id,
    at: NOW,
    kind: "round",
    round: "rnd_1",
    repo,
    branch: "feat/ledger",
    base: "main",
    base_commit: "a1b2c3d",
    head_commit: "9f8e7d6",
    stats: { files_changed: 2, insertions: 1, deletions: 1, binary_skipped: 1 },
    groups: ["Write path"],
  });
});

test("a round writes one round_file per non-binary file, with the patch and both blobs", () => {
  const records = roundRecords({ round: "rnd_1", session: session(), repo, now: NOW, nextId });
  const files = records.filter((record) => record.kind === "round_file") as RoundFileRecord[];

  assert.equal(files.length, 1);
  assert.equal(files[0]?.file, "src/server.ts");
  assert.equal(files[0]?.group, "Write path");
  assert.equal(files[0]?.blob_old, "11ab34c");
  assert.equal(files[0]?.blob_new, "4c9f88d");
  assert.equal(files[0]?.patch, changed.diff);
  assert.equal(files[0]?.previous_path, null);
});

test("a patch without an index line leaves both blobs null rather than guessing", () => {
  const file: DiffFile = { ...changed, diff: "@@ -1 +1 @@\n-old\n+new" };
  const records = roundRecords({
    round: "rnd_1",
    session: session({ groups: [{ name: "g", rationale: "r", files: [file] }] }),
    repo,
    now: NOW,
    nextId,
  });
  const [, roundFile] = records as [RoundRecord, RoundFileRecord];

  assert.equal(roundFile.blob_old, null);
  assert.equal(roundFile.blob_new, null);
});

test("a renamed file carries the name its old version is stored under", () => {
  const file: DiffFile = { ...changed, status: "renamed", previousPath: "src/old.ts" };
  const records = roundRecords({
    round: "rnd_1",
    session: session({ groups: [{ name: "g", rationale: "r", files: [file] }] }),
    repo,
    now: NOW,
    nextId,
  });
  const [, roundFile] = records as [RoundRecord, RoundFileRecord];

  assert.equal(roundFile.previous_path, "src/old.ts");
  assert.equal(roundFile.file_status, "renamed");
});

test("every record of a round shares its timestamp and has its own id", () => {
  const records = roundRecords({ round: "rnd_1", session: session(), repo, now: NOW, nextId });

  assert.deepEqual([...new Set(records.map((record) => record.at))], [NOW]);
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);
});

test("an annotation prompt is logged joined to the file it was made on", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [
      {
        type: "annotation",
        file: "src/server.ts",
        group: "Write path",
        selected_text: "+new",
        comment: "Return a ReviewError",
      },
    ],
    now: NOW,
    nextId,
  });
  const annotation = records[0] as AnnotationRecord;

  assert.equal(records.length, 1);
  assert.equal(annotation.kind, "annotation");
  assert.equal(annotation.round, "rnd_1");
  assert.equal(annotation.file, "src/server.ts");
  assert.equal(annotation.file_status, "modified");
  assert.equal(annotation.blob_new, "4c9f88d");
  assert.equal(annotation.comment, "Return a ReviewError");
  assert.equal(annotation.selected_text, "+new");
  assert.equal(annotation.branch, "feat/ledger");
});

test("an annotation on a file this round does not list is still logged, without file facts", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [
      {
        type: "annotation",
        file: "src/gone.ts",
        group: "Write path",
        selected_text: "x",
        comment: "c",
      },
    ],
    now: NOW,
    nextId,
  });
  const annotation = records[0] as AnnotationRecord;

  assert.equal(annotation.file, "src/gone.ts");
  assert.equal(annotation.file_status, null);
  assert.equal(annotation.blob_new, null);
  assert.equal(annotation.blob_old, null);
});

test("an annotation is logged with the code around it, cut from the side it was made on", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: readVersion,
    prompts: [
      {
        type: "annotation",
        file: "src/server.ts",
        group: "Write path",
        selected_text: "old marker",
        comment: "c",
        line_start: 3,
        line_end: 3,
        side: "old",
      },
    ],
    now: NOW,
    nextId,
  });
  const annotation = records[0] as AnnotationRecord;

  assert.equal(annotation.context, versions.old);
  assert.equal(annotation.context_source, "anchor");
});

test("an annotation with no anchor takes its context from the new side by search", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: readVersion,
    prompts: [
      {
        type: "annotation",
        file: "src/server.ts",
        group: "Write path",
        selected_text: "new marker",
        comment: "c",
      },
    ],
    now: NOW,
    nextId,
  });
  const annotation = records[0] as AnnotationRecord;

  assert.equal(annotation.context, versions.new);
  assert.equal(annotation.context_source, "search");
});

test("an annotation on a file git cannot produce is logged without context", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [
      {
        type: "annotation",
        file: "logo.png",
        group: "Write path",
        selected_text: "x",
        comment: "c",
      },
    ],
    now: NOW,
    nextId,
  });
  const annotation = records[0] as AnnotationRecord;

  assert.equal("context" in annotation, false);
  assert.equal(annotation.context_source, "none");
});

test("the line anchor the browser captured is logged with the annotation", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [
      {
        type: "annotation",
        file: "src/server.ts",
        group: "Write path",
        selected_text: "+new",
        comment: "c",
        line_start: 12,
        line_end: 14,
        side: "new",
      },
    ],
    now: NOW,
    nextId,
  });
  const annotation = records[0] as AnnotationRecord;

  assert.equal(annotation.line_start, 12);
  assert.equal(annotation.line_end, 14);
  assert.equal(annotation.side, "new");
});

test("the columns of a part-line selection are logged with the annotation", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [
      {
        type: "annotation",
        file: "src/server.ts",
        group: "Write path",
        selected_text: "fetchUser(id)",
        comment: "c",
        line_start: 12,
        line_end: 12,
        side: "new",
        col_start: 14,
        col_end: 26,
      },
    ],
    now: NOW,
    nextId,
  });
  const annotation = records[0] as AnnotationRecord;

  assert.equal(annotation.col_start, 14);
  assert.equal(annotation.col_end, 26);
});

test("an annotation without an anchor is logged without the fields", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [
      {
        type: "annotation",
        file: "src/server.ts",
        group: "Write path",
        selected_text: "+new",
        comment: "c",
      },
    ],
    now: NOW,
    nextId,
  });

  assert.equal("line_start" in records[0]!, false);
  assert.equal("side" in records[0]!, false);
});

test("a general comment is logged as a message record", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [{ type: "message", comment: "Please add tests" }],
    now: NOW,
    nextId,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0]?.kind, "message");
});

test("one record is written per prompt, in the order they were sent", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [
      { type: "message", comment: "first" },
      {
        type: "annotation",
        file: "src/server.ts",
        group: "Write path",
        selected_text: "+new",
        comment: "second",
      },
      { type: "message", comment: "third" },
    ],
    now: NOW,
    nextId,
  });

  assert.deepEqual(
    records.map((record) => record.kind),
    ["message", "annotation", "message"],
  );
});

test("an agent reply is logged as its own kind", () => {
  const records = agentReplyRecords({
    session: session(),
    repo,
    comment: "Fixed",
    now: NOW,
    nextId,
  });

  assert.equal(records[0]?.kind, "agent_reply");
  assert.equal(records.length, 1);
});

test("a prompt the server already stamped keeps its id in the ledger", () => {
  const records = feedbackRecords({
    session: session(),
    repo,
    readFile: noFile,
    prompts: [
      {
        type: "annotation",
        id: "evt_stamped_0001",
        file: "src/server.ts",
        group: "Write path",
        selected_text: "+new",
        comment: "Return a ReviewError",
      },
    ],
    now: NOW,
    nextId,
  });

  assert.equal(records[0]?.id, "evt_stamped_0001");
});

test("each declared comment writes one declaration record naming that comment", () => {
  const records = declarationRecords({
    session: session(),
    repo,
    declarations: [
      { id: "evt_a", files: ["src/server.ts"], note: "one transaction now" },
      { id: "evt_b", files: [] },
    ],
    now: NOW,
    nextId,
  });

  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => record.kind),
    ["declaration", "declaration"],
  );
  const [first, second] = records;
  assert.equal(first?.kind === "declaration" ? first.about : "", "evt_a");
  assert.deepEqual(first?.kind === "declaration" ? first.files : [], ["src/server.ts"]);
  assert.equal(first?.kind === "declaration" ? first.note : "", "one transaction now");
  assert.equal(second?.kind === "declaration" ? second.about : "", "evt_b");
  assert.equal(second?.kind === "declaration" && "note" in second, false);
  assert.equal(second?.kind === "declaration" ? second.round : "", "rnd_1");
});

test("the end of a round records which files the reviewer had ticked approved", () => {
  const records = roundEndRecords({
    session: session({ approved: ["src/server.ts"] }),
    repo,
    now: NOW,
    nextId,
  });

  assert.equal(records[0]?.kind, "round_end");
  assert.deepEqual(records[0]?.kind === "round_end" ? records[0].approved : [], ["src/server.ts"]);
});

test("a session written before the ledger existed still logs, with an unknown round", () => {
  const records = agentReplyRecords({
    session: session({ round: undefined }),
    repo,
    comment: "Fixed",
    now: NOW,
    nextId,
  });

  assert.equal(records[0]?.kind === "agent_reply" ? records[0].round : "", "unknown");
});

test("recording with no ledger reports the feature off and writes nothing", () => {
  const result = recordSafely(
    undefined,
    roundRecords({ round: "r", session: session(), repo, now: NOW, nextId }),
  );

  assert.deepEqual(result, { status: "off", written: 0, failed: 0 });
});

test("a healthy ledger reports its path and how many records it took", () => {
  const store = newStore();

  const result = recordSafely(
    store,
    roundRecords({ round: "r", session: session(), repo, now: NOW, nextId }),
  );

  assert.equal(result.status, "on");
  assert.equal(result.path, store.path);
  assert.equal(result.written, 2);
  assert.equal(result.failed, 0);
  assert.equal(store.read({}).records.length, 2);
});

test("a ledger that cannot be written degrades with a reason instead of throwing", () => {
  const result = recordSafely(
    unwritableStore(),
    roundRecords({ round: "r", session: session(), repo, now: NOW, nextId }),
  );

  assert.equal(result.status, "degraded");
  assert.equal(result.written, 0);
  assert.equal(result.failed, 2);
  assert.match(result.reason ?? "", /ENOTDIR|not a directory/i);
});
