import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerStore, ledgerFor } from "../../src/ledger/store.ts";
import {
  buildAnnotationRecord,
  buildMessageRecord,
  buildOutcomeRecord,
  type LedgerRecord,
} from "../../src/ledger/records.ts";

function newDir(): string {
  return join(mkdtempSync(join(tmpdir(), "lsr-ledger-")), "feedback");
}

const repo = { root: "/home/dev/app", name: "app", remote: null };

function message(id: string, at: string, comment = "note"): LedgerRecord {
  return buildMessageRecord({ id, at, round: "rnd_1", repo, branch: "b", base: "main", comment });
}

test("append creates the ledger directory and reads back what it wrote", () => {
  const store = new LedgerStore(newDir());

  assert.deepEqual(store.append(message("evt_1", "2026-02-14T09:00:00.000Z")), { ok: true });

  const read = store.read({});
  assert.equal(read.records.length, 1);
  assert.equal(read.records[0]?.id, "evt_1");
  assert.equal(read.corrupt, 0);
});

test("each record is one newline-terminated JSON line", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);

  store.append(message("evt_1", "2026-02-14T09:00:00.000Z", "first"));
  store.append(message("evt_2", "2026-02-14T09:00:01.000Z", "second"));

  const contents = readFileSync(join(dir, "2026-02.jsonl"), "utf8");
  assert.equal(contents.split("\n").length, 3);
  assert.equal(contents.endsWith("\n"), true);
  assert.equal(contents.includes("\n{"), true);
});

test("records are written into a file per calendar month of their timestamp", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);

  store.append(message("evt_1", "2026-01-31T23:59:59.000Z"));
  store.append(message("evt_2", "2026-02-01T00:00:00.000Z"));

  assert.deepEqual(readdirSync(dir).sort(), ["2026-01.jsonl", "2026-02.jsonl"]);
});

test("read returns records from every month in chronological order", () => {
  const store = new LedgerStore(newDir());

  store.append(message("evt_2", "2026-02-01T00:00:00.000Z"));
  store.append(message("evt_1", "2026-01-01T00:00:00.000Z"));

  assert.deepEqual(
    store.read({}).records.map((record) => record.id),
    ["evt_1", "evt_2"],
  );
});

test("a corrupt line is skipped and counted, not thrown", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  writeFileSync(join(dir, "2026-02.jsonl"), "{not json\n", { flag: "a" });
  store.append(message("evt_2", "2026-02-14T09:00:02.000Z"));

  const read = store.read({});

  assert.deepEqual(
    read.records.map((record) => record.id),
    ["evt_1", "evt_2"],
  );
  assert.equal(read.corrupt, 1);
});

test("a line without an id or a timestamp counts as corrupt", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  writeFileSync(join(dir, "2026-02.jsonl"), '{"kind":"message"}\n[]\n', { flag: "a" });

  const read = store.read({});

  assert.equal(read.records.length, 1);
  assert.equal(read.corrupt, 2);
});

test("a line whose kind is not a ledger kind counts as corrupt", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  writeFileSync(
    join(dir, "2026-02.jsonl"),
    `${JSON.stringify({ id: "evt_x", at: "2026-02-14T09:00:01.000Z", kind: "gossip", repo })}\n`,
    { flag: "a" },
  );

  const read = store.read({});

  assert.equal(read.records.length, 1);
  assert.equal(read.corrupt, 1);
});

/**
 * Every reader joins, filters and prunes by the repo a record names, so a line
 * without one would reach pure code as a typed record that lies about itself.
 */
test("a line without a repo reference counts as corrupt", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  writeFileSync(
    join(dir, "2026-02.jsonl"),
    `${JSON.stringify({ id: "evt_x", at: "2026-02-14T09:00:01.000Z", kind: "annotation" })}\n` +
      `${JSON.stringify({ id: "evt_y", at: "2026-02-14T09:00:02.000Z", kind: "annotation", repo: { root: 7 } })}\n`,
    { flag: "a" },
  );

  const read = store.read({});

  assert.equal(read.records.length, 1);
  assert.equal(read.corrupt, 2);
});

test("blank lines are ignored and are not corruption", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  writeFileSync(join(dir, "2026-02.jsonl"), "\n\n", { flag: "a" });

  const read = store.read({});

  assert.equal(read.records.length, 1);
  assert.equal(read.corrupt, 0);
});

test("unknown fields on a schema 1 line survive the round trip", () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "2026-02.jsonl"),
    `${JSON.stringify({ schema: 1, id: "evt_9", at: "2026-02-14T09:00:00.000Z", kind: "message", repo, future_field: "keep me" })}\n`,
  );

  const [record] = new LedgerStore(dir).read({}).records;

  assert.equal((record as unknown as { future_field: string }).future_field, "keep me");
});

test("since keeps only records at or after the given timestamp", () => {
  const store = new LedgerStore(newDir());
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  store.append(message("evt_2", "2026-02-14T10:00:00.000Z"));

  const read = store.read({ since: "2026-02-14T10:00:00.000Z" });

  assert.deepEqual(
    read.records.map((record) => record.id),
    ["evt_2"],
  );
});

test("cursor resumes strictly after the id it was given", () => {
  const store = new LedgerStore(newDir());
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  store.append(message("evt_2", "2026-02-14T10:00:00.000Z"));
  store.append(message("evt_3", "2026-02-14T11:00:00.000Z"));

  const read = store.read({ cursor: "evt_1" });

  assert.deepEqual(
    read.records.map((record) => record.id),
    ["evt_2", "evt_3"],
  );
});

test("limit returns the oldest matching records first and reports more to come", () => {
  const store = new LedgerStore(newDir());
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  store.append(message("evt_2", "2026-02-14T10:00:00.000Z"));
  store.append(message("evt_3", "2026-02-14T11:00:00.000Z"));

  const read = store.read({ limit: 2 });

  assert.deepEqual(
    read.records.map((record) => record.id),
    ["evt_1", "evt_2"],
  );
  assert.equal(read.hasMore, true);
  assert.equal(read.matched, 3);
});

test("read of a ledger that was never written is empty, not an error", () => {
  const read = new LedgerStore(newDir()).read({});

  assert.deepEqual(read.records, []);
  assert.equal(read.corrupt, 0);
  assert.equal(read.hasMore, false);
});

test("an unwritable ledger directory degrades instead of throwing", () => {
  const file = join(mkdtempSync(join(tmpdir(), "lsr-ledger-")), "blocker");
  writeFileSync(file, "not a directory");
  const store = new LedgerStore(join(file, "feedback"));

  const result = store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /ENOTDIR|not a directory/i);
});

test("stats precomputes counts and the date range so a caller never sums lines", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-01-04T09:00:00.000Z"));
  store.append(message("evt_2", "2026-02-14T09:00:00.000Z"));
  writeFileSync(join(dir, "2026-02.jsonl"), "{oops\n", { flag: "a" });

  const stats = store.stats();

  assert.equal(stats.records, 2);
  assert.equal(stats.corrupt, 1);
  assert.equal(stats.months, 2);
  assert.equal(stats.first, "2026-01-04T09:00:00.000Z");
  assert.equal(stats.last, "2026-02-14T09:00:00.000Z");
  assert.ok(stats.bytes > 0);
});

test("stats on an empty ledger is a definitive zero", () => {
  const stats = new LedgerStore(newDir()).stats();

  assert.deepEqual(stats, {
    records: 0,
    corrupt: 0,
    months: 0,
    bytes: 0,
    first: undefined,
    last: undefined,
  });
});

test("rewrite keeps only approved records and reports what it removed", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-01-04T09:00:00.000Z"));
  store.append(message("evt_2", "2026-02-14T09:00:00.000Z"));
  store.append(message("evt_3", "2026-02-14T10:00:00.000Z"));

  const result = store.rewrite((record) => record.id !== "evt_2");

  assert.deepEqual(result, { removed: 1, kept: 2, corrupt: 0 });
  assert.deepEqual(
    store.read({}).records.map((record) => record.id),
    ["evt_1", "evt_3"],
  );
  const february = readFileSync(join(dir, "2026-02.jsonl"), "utf8");
  assert.equal(february.trimEnd().split("\n").length, 1);
  assert.equal((JSON.parse(february.trim()) as { id: string }).id, "evt_3");
});

test("rewrite deletes a month file it emptied and leaves no temporary files", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-01-04T09:00:00.000Z"));
  store.append(message("evt_2", "2026-02-14T09:00:00.000Z"));

  const result = store.rewrite((record) => record.at >= "2026-02-01");

  assert.deepEqual(result, { removed: 1, kept: 1, corrupt: 0 });
  assert.deepEqual(readdirSync(dir), ["2026-02.jsonl"]);
});

test("rewrite leaves a month it removes nothing from untouched on disk", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-01-04T09:00:00.000Z"));
  store.append(message("evt_2", "2026-02-14T09:00:00.000Z"));
  const january = join(dir, "2026-01.jsonl");
  const before = { contents: readFileSync(january, "utf8"), mtime: statSync(january).mtimeMs };

  store.rewrite((record) => record.at < "2026-02-01");

  assert.equal(readFileSync(january, "utf8"), before.contents);
  assert.equal(statSync(january).mtimeMs, before.mtime, "an untouched month is not rewritten");
});

test("rewrite counts dropped corrupt lines apart from the records it removed", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  writeFileSync(join(dir, "2026-02.jsonl"), "{not json\n", { flag: "a" });

  assert.deepEqual(
    store.rewrite(() => true),
    { removed: 0, kept: 1, corrupt: 1 },
  );
  assert.equal(store.read({}).corrupt, 0);
});

test("rewrite of a ledger that was never written removes nothing", () => {
  assert.deepEqual(
    new LedgerStore(newDir()).rewrite(() => true),
    { removed: 0, kept: 0, corrupt: 0 },
  );
});

function annotation(id: string, at: string, round = "rnd_1", where = repo): LedgerRecord {
  return buildAnnotationRecord({
    id,
    at,
    round,
    repo: where,
    branch: "b",
    base: "main",
    base_commit: null,
    head_commit: null,
    file: "src/a.ts",
    previous_path: null,
    file_status: "modified",
    group: "All Changes",
    blob_new: null,
    blob_old: null,
    selected_text: "x",
    comment: "fix",
  });
}

test("a kind filter returns only that kind", () => {
  const store = new LedgerStore(newDir());
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z"));
  store.append(annotation("evt_2", "2026-02-14T09:00:01.000Z"));

  const read = store.read({ kind: "annotation" });

  assert.deepEqual(
    read.records.map((record) => record.id),
    ["evt_2"],
  );
  assert.equal(read.matched, 1);
});

test("a repo filter keeps another repo's records out, comment text included", () => {
  const other = { root: "/home/dev/other", name: "other", remote: null };
  const store = new LedgerStore(newDir());
  store.append(message("evt_1", "2026-02-14T09:00:00.000Z", "about /home/dev/other really"));
  store.append(message("evt_2", "2026-02-14T09:00:01.000Z"));
  store.append(
    buildMessageRecord({
      id: "evt_3",
      at: "2026-02-14T09:00:02.000Z",
      round: "rnd_1",
      repo: other,
      branch: "b",
      base: "main",
      comment: "note",
    }),
  );

  assert.deepEqual(
    store.read({ repo: other.root }).records.map((record) => record.id),
    ["evt_3"],
  );
});

test("a rounds filter keeps only the named rounds", () => {
  const store = new LedgerStore(newDir());
  store.append(annotation("evt_1", "2026-02-14T09:00:00.000Z", "rnd_1"));
  store.append(annotation("evt_2", "2026-02-14T09:00:01.000Z", "rnd_2"));
  store.append(annotation("evt_3", "2026-02-14T09:00:02.000Z", "rnd_3"));

  assert.deepEqual(
    store.read({ rounds: ["rnd_1", "rnd_3"] }).records.map((record) => record.id),
    ["evt_1", "evt_3"],
  );
});

test("a rounds filter never matches a record that has no round of its own", () => {
  const store = new LedgerStore(newDir());
  store.append(
    buildOutcomeRecord({
      id: "evt_1",
      at: "2026-02-14T09:00:00.000Z",
      repo,
      about: "evt_0",
      next_round: "rnd_2",
      from_commit: null,
      to_commit: null,
      file_touched: false,
      re_annotated: false,
      approved: false,
      verdict: "unknown",
    }),
  );

  assert.deepEqual(store.read({ rounds: ["rnd_2"] }).records, []);
});

test("filters compose with since, cursor and limit", () => {
  const store = new LedgerStore(newDir());
  store.append(annotation("evt_1", "2026-01-14T09:00:00.000Z"));
  store.append(annotation("evt_2", "2026-02-14T09:00:00.000Z"));
  store.append(message("evt_3", "2026-02-14T09:00:01.000Z"));
  store.append(annotation("evt_4", "2026-02-14T09:00:02.000Z"));

  const read = store.read({ kind: "annotation", since: "2026-02-01T00:00:00.000Z", limit: 1 });

  assert.deepEqual(
    read.records.map((record) => record.id),
    ["evt_2"],
  );
  assert.equal(read.matched, 2);
  assert.equal(read.hasMore, true);
});

test("a since inside a month still reads that month's later records", () => {
  const store = new LedgerStore(newDir());
  store.append(annotation("evt_1", "2026-02-01T00:00:00.000Z"));
  store.append(annotation("evt_2", "2026-02-28T23:59:59.000Z"));

  assert.deepEqual(
    store.read({ since: "2026-02-14T09:00:00.000Z" }).records.map((record) => record.id),
    ["evt_2"],
  );
});

test("since skips whole month files instead of parsing them", () => {
  const dir = newDir();
  const store = new LedgerStore(dir);
  store.append(message("evt_1", "2026-01-14T09:00:00.000Z"));
  writeFileSync(join(dir, "2026-01.jsonl"), "{not json\n", { flag: "a" });
  store.append(message("evt_2", "2026-03-14T09:00:00.000Z"));

  assert.equal(store.read({}).corrupt, 1);
  assert.equal(store.read({ since: "2026-02-01T00:00:00.000Z" }).corrupt, 0);
});

test("the store reports the path it writes to", () => {
  const dir = newDir();

  assert.equal(new LedgerStore(dir).path, dir);
});

test("feedbackLog on gives a store rooted in the state dir's feedback directory", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-state-"));

  assert.equal(ledgerFor("on", stateDir)?.path, join(stateDir, "feedback"));
});

test("feedbackLog off gives no store at all, so nothing can be written", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-state-"));

  assert.equal(ledgerFor("off", stateDir), undefined);
  assert.equal(existsSync(join(stateDir, "feedback")), false);
});
