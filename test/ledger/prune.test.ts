import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAnnotationRecord,
  buildMessageRecord,
  type LedgerRecord,
  type RepoRef,
} from "../../src/ledger/records.ts";
import { prunePlan } from "../../src/ledger/prune.ts";

/**
 * The plan is what `prune` and `prune --dry-run` both print, so its arithmetic
 * is proven against the records: bucketing, file fates, removed-range endpoints.
 */

const repo: RepoRef = { root: "/home/dev/app", name: "app", remote: null };

function annotation(id: string, at: string): LedgerRecord {
  return buildAnnotationRecord({
    id,
    at,
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
    line_start: 1,
    line_end: 1,
    side: "new",
    selected_text: "const a = 1;",
    comment: "name this",
    context: "surrounding lines",
    context_source: "anchor",
  });
}

function message(id: string, at: string): LedgerRecord {
  return buildMessageRecord({
    id,
    at,
    round: "rnd_1",
    repo,
    branch: "feat/ledger",
    base: "main",
    comment: "general note, not an item",
  });
}

const RECORDS = [
  annotation("evt_1", "2026-01-04T09:00:00.000Z"),
  message("evt_2", "2026-01-20T09:00:00.000Z"),
  annotation("evt_3", "2026-02-14T09:00:00.000Z"),
  annotation("evt_4", "2026-02-15T09:00:00.000Z"),
];

const keepFrom = (cutoff: string) => (record: LedgerRecord) => record.at >= cutoff;

test("a cutoff inside a month rewrites that file and deletes fully-old ones", () => {
  const plan = prunePlan(RECORDS, keepFrom("2026-02-15T00:00:00.000Z"));

  assert.equal(plan.removed, 3);
  assert.equal(plan.kept, 1);
  assert.deepEqual(plan.months, [
    { month: "2026-01", removed: 2, kept: 0, file: "deleted" },
    { month: "2026-02", removed: 1, kept: 1, file: "rewritten" },
  ]);
});

test("itemsRemoved counts annotations only, not the plumbing records", () => {
  const plan = prunePlan(RECORDS, keepFrom("2026-02-01T00:00:00.000Z"));

  assert.equal(plan.removed, 2, "the message is removed too");
  assert.equal(plan.itemsRemoved, 1, "but only the annotation is a feedback item");
});

test("the removed range spans the oldest and newest record actually removed", () => {
  const plan = prunePlan(RECORDS, keepFrom("2026-02-15T00:00:00.000Z"));

  assert.equal(plan.oldestRemoved, "2026-01-04T09:00:00.000Z");
  assert.equal(plan.newestRemoved, "2026-02-14T09:00:00.000Z");
});

test("a keep-everything plan removes nothing and reports no removed range", () => {
  const plan = prunePlan(RECORDS, () => true);

  assert.equal(plan.removed, 0);
  assert.equal(plan.kept, 4);
  assert.equal(plan.oldestRemoved, undefined);
  assert.equal(plan.newestRemoved, undefined);
  assert.deepEqual(
    plan.months.map((row) => row.file),
    ["kept", "kept"],
  );
});
