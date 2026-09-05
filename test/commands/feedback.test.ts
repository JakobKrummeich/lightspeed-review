import { test } from "node:test";
import assert from "node:assert/strict";
import { AxiError, exitCodeForError } from "axi-sdk-js";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHelp } from "../../src/commands/command-help.ts";
import { FEEDBACK_SUBCOMMANDS, runFeedback } from "../../src/commands/feedback.ts";
import { DEFAULT_LIST_LIMIT, DEFAULT_LIST_MAX_BYTES } from "../../src/commands/feedback/shared.ts";
import { ReviewError } from "../../src/errors.ts";
import {
  buildAnnotationRecord,
  buildMessageRecord,
  buildOutcomeRecord,
  buildRoundFileRecord,
  type LedgerRecord,
  type RepoRef,
  type Verdict,
} from "../../src/ledger/records.ts";
import { LedgerStore } from "../../src/ledger/store.ts";
import { feedbackDirPath } from "../../src/paths.ts";

const repo: RepoRef = { root: "/home/dev/app", name: "app", remote: "github.com/acme/app" };
const other: RepoRef = { root: "/home/dev/other", name: "other", remote: null };

function annotation(options: {
  id: string;
  at: string;
  round?: string;
  repo?: RepoRef;
  file?: string;
  comment?: string;
}): LedgerRecord {
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
    selected_text: "if (!ok) throw new Error()",
    comment: options.comment ?? "Return a ReviewError instead",
    context: "surrounding lines",
    context_source: "anchor",
  });
}

function roundFile(round: string, file: string, patch: string): LedgerRecord {
  return buildRoundFileRecord({
    id: `evt_rf_${round}_${file}`,
    at: "2026-02-14T08:00:00.000Z",
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

function outcome(about: string, verdict: Verdict): LedgerRecord {
  return buildOutcomeRecord({
    id: `evt_out_${about}`,
    at: "2026-02-15T09:00:00.000Z",
    repo,
    about,
    next_round: "rnd_2",
    from_commit: "9f8e7d6",
    to_commit: "5b4a392",
    file_touched: true,
    response_patch: "@@ -214,6 +214,8 @@ fixed",
    re_annotated: verdict === "repeated",
    approved: verdict === "addressed",
    verdict,
  });
}

/** A ledger with two repos, two months, one judged and two unresolved items. */
function seededState(): string {
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-feedback-"));
  const store = new LedgerStore(feedbackDirPath(stateDir));
  for (const record of [
    roundFile("rnd_1", "src/server.ts", "@@ -1,3 +1,4 @@ server patch"),
    roundFile("rnd_1", "src/ledger/store.ts", "@@ -1,3 +1,4 @@ store patch"),
    annotation({ id: "evt_1", at: "2026-01-04T09:00:00.000Z" }),
    annotation({
      id: "evt_2",
      at: "2026-02-14T09:00:00.000Z",
      file: "src/ledger/store.ts",
      comment: "Cap this field",
    }),
    annotation({ id: "evt_3", at: "2026-02-14T10:00:00.000Z", repo: other }),
    buildMessageRecord({
      id: "evt_msg",
      at: "2026-02-14T09:30:00.000Z",
      round: "rnd_1",
      repo,
      branch: "feat/ledger",
      base: "main",
      comment: "general note, not an item",
    }),
    outcome("evt_1", "repeated"),
  ]) {
    assert.deepEqual(store.append(record), { ok: true });
  }
  return stateDir;
}

function emptyState(): string {
  return mkdtempSync(join(tmpdir(), "lsr-feedback-empty-"));
}

/** One repo, `count` items in time order, ids `evt_001`… — enough to outgrow the
 * default page, and with a comment long enough to outgrow the byte budget. */
function bulkState(count: number, comment?: string): string {
  const stateDir = mkdtempSync(join(tmpdir(), "lsr-feedback-bulk-"));
  const store = new LedgerStore(feedbackDirPath(stateDir));
  for (let index = 0; index < count; index += 1) {
    const record = annotation({
      id: `evt_${String(index + 1).padStart(3, "0")}`,
      at: `2026-02-14T09:${String(index).padStart(2, "0")}:00.000Z`,
      ...(comment === undefined ? {} : { comment }),
    });
    assert.deepEqual(store.append(record), { ok: true });
  }
  return stateDir;
}

function feedback(args: string[], stateDir: string, feedbackLog: "on" | "off" = "on") {
  return runFeedback({ args, repoRoot: repo.root, stateDir, feedbackLog });
}

function asRecord(output: unknown): Record<string, unknown> {
  assert.equal(typeof output, "object");
  return output as Record<string, unknown>;
}

function asText(output: unknown): string {
  assert.equal(typeof output, "string");
  return output as string;
}

test("every subcommand is reachable and documented, so none can rot unnoticed", () => {
  const help = commandHelp("feedback") ?? "";
  const stateDir = seededState();

  assert.deepEqual([...FEEDBACK_SUBCOMMANDS].sort(), ["list", "prune", "show"]);
  for (const name of FEEDBACK_SUBCOMMANDS) {
    assert.match(help, new RegExp(`feedback ${name}`), name);
  }
  assert.doesNotThrow(() => feedback(["list"], stateDir));
  assert.doesNotThrow(() => feedback(["show", "evt_1"], stateDir));
  assert.doesNotThrow(() => feedback(["prune", "--before", "2020-01-01"], stateDir));
});

test("the bare command summarises the ledger with precomputed aggregates", () => {
  const stateDir = seededState();

  const output = asRecord(feedback([], stateDir));
  const ledger = asRecord(output.ledger);

  assert.equal(ledger.path, feedbackDirPath(stateDir));
  assert.equal(ledger.status, "on");
  assert.equal(ledger.items, 3);
  assert.equal(ledger.records, 7, "raw records, not items: messages and round files count too");
  assert.equal(ledger.repos, 2);
  assert.equal(ledger.first, "2026-01-04T09:00:00.000Z");
  assert.equal(ledger.last, "2026-02-14T10:00:00.000Z");
  assert.equal(ledger.unresolved, 2);
  assert.deepEqual(output.verdicts, {
    addressed: 0,
    ignored: 0,
    repeated: 1,
    unknown: 2,
    unresolved: 2,
  });
  assert.deepEqual(output.repos, [
    { name: "app", root: repo.root, items: 2, addressed: 0, ignored: 0, repeated: 1, unknown: 1 },
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
  assert.ok(Array.isArray(output.help));
});

test("an empty ledger answers with a definitive zero and how to produce data", () => {
  const output = asRecord(feedback([], emptyState()));

  assert.equal(output.items, 0);
  assert.match(String(output.message), /no feedback/i);
  assert.match(JSON.stringify(output.help), /lightspeed start/);
});

test("a ledger switched off says so instead of reporting an empty one", () => {
  const output = asRecord(feedback([], seededState(), "off"));

  assert.equal(asRecord(output.ledger).status, "off");
  assert.equal(output.items, 0);
  assert.match(JSON.stringify(output.help), /feedbackLog/);
});

test("list returns joined items oldest first with precomputed counts", () => {
  const output = asRecord(feedback(["list"], seededState()));
  const items = output.items as { id: string; file: string; verdict: string; patch?: string }[];

  assert.deepEqual(
    items.map((item) => item.id),
    ["evt_1", "evt_2", "evt_3"],
  );
  assert.deepEqual(asRecord(output.count), {
    matched: 3,
    included: 3,
    omitted: 0,
    truncated: 0,
    bytes: asRecord(output.count).bytes,
    has_more: false,
  });
  assert.equal(output.cursor, "evt_3");
  assert.equal(items[0]?.verdict, "repeated");
});

test("list drops patches unless asked and marks that it did", () => {
  const stateDir = seededState();

  const withoutPatches = asRecord(feedback(["list"], stateDir)).items as Record<string, unknown>[];
  const withPatches = asRecord(feedback(["list", "--with-patches"], stateDir)).items as Record<
    string,
    unknown
  >[];

  assert.equal(withoutPatches[0]?.patch, undefined);
  assert.equal(withoutPatches[0]?.patch_omitted, true);
  assert.equal(withPatches[0]?.patch, "@@ -1,3 +1,4 @@ server patch");
});

test("list drops the code context on the same switch and marks that it did", () => {
  const stateDir = seededState();

  const withoutPatches = asRecord(feedback(["list"], stateDir)).items as Record<string, unknown>[];
  const withPatches = asRecord(feedback(["list", "--with-patches"], stateDir)).items as Record<
    string,
    unknown
  >[];

  assert.equal(withoutPatches[0]?.context, undefined);
  assert.equal(withoutPatches[0]?.context_source, undefined);
  assert.equal(withoutPatches[0]?.context_omitted, true);
  assert.equal(withPatches[0]?.context, "surrounding lines");
  assert.equal(withPatches[0]?.context_omitted, undefined);
});

test("a bare list stops at the default page instead of dumping the whole ledger", () => {
  const output = asRecord(feedback(["list"], bulkState(25)));
  const count = asRecord(output.count);

  assert.equal(count.matched, 25);
  assert.equal(count.included, DEFAULT_LIST_LIMIT);
  assert.equal(count.has_more, true);
  assert.equal(output.cursor, "evt_020");
  assert.equal(asRecord(output.filters).limit, DEFAULT_LIST_LIMIT, "the cap is echoed as a filter");
});

test("the default byte budget holds back a page too big to be worth reading", () => {
  const output = asRecord(feedback(["list"], bulkState(25, "x".repeat(6000))));
  const count = asRecord(output.count);

  assert.ok((count.included as number) < DEFAULT_LIST_LIMIT, "bytes bit before the item limit");
  assert.ok((count.omitted as number) > 0);
  assert.ok((count.bytes as number) <= DEFAULT_LIST_MAX_BYTES);
  assert.equal(count.has_more, true);
});

test("explicit caps are taken as given rather than narrowed by the defaults", () => {
  const output = asRecord(
    feedback(["list", "--limit", "25", "--max-bytes", "500000"], bulkState(25)),
  );
  const count = asRecord(output.count);

  assert.equal(count.included, 25);
  assert.equal(count.omitted, 0);
  assert.equal(count.has_more, false);
});

test("raw formats stay uncapped, because a default cut there would be invisible", () => {
  const stateDir = bulkState(25);

  const jsonl = asText(feedback(["list", "--format", "jsonl"], stateDir));
  const markdown = asText(feedback(["list", "--format", "md"], stateDir));

  assert.equal(jsonl.split("\n").length, 25, "no count block means nothing could report a cut");
  assert.equal(markdown.match(/^## /gm)?.length, 25);
});

test("raw formats still honour caps the caller asked for", () => {
  const text = asText(feedback(["list", "--format", "jsonl", "--limit", "2"], bulkState(25)));

  assert.equal(text.split("\n").length, 2);
});

test("a page cut by the defaults says which flags and cursor lift them", () => {
  const help = JSON.stringify(asRecord(feedback(["list"], bulkState(25))).help);

  assert.match(help, /--limit/);
  assert.match(help, /--cursor evt_020/);
  assert.match(help, /--with-patches/);
});

test("a page the caller's own flags cut does not blame a default it never used", () => {
  const help = JSON.stringify(
    asRecord(feedback(["list", "--limit", "2", "--max-bytes", "500000"], bulkState(25))).help,
  );

  assert.match(help, /--cursor evt_002/);
  assert.doesNotMatch(help, new RegExp(String(DEFAULT_LIST_LIMIT)));
});

test("list filters by repo, verdict and file", () => {
  const stateDir = seededState();

  const byRepo = asRecord(feedback(["list", "--repo", other.root], stateDir));
  const byVerdict = asRecord(feedback(["list", "--verdict", "repeated"], stateDir));
  const byFile = asRecord(feedback(["list", "--file", "src/ledger"], stateDir));

  assert.deepEqual(
    (byRepo.items as { id: string }[]).map((item) => item.id),
    ["evt_3"],
  );
  assert.deepEqual(
    (byVerdict.items as { id: string }[]).map((item) => item.id),
    ["evt_1"],
  );
  assert.deepEqual(
    (byFile.items as { id: string }[]).map((item) => item.id),
    ["evt_2"],
  );
  assert.deepEqual(asRecord(byRepo.filters).repo, other.root);
});

test("--repo . means the repository the command runs in", () => {
  const output = asRecord(feedback(["list", "--repo", "."], seededState()));

  assert.deepEqual(
    (output.items as { id: string }[]).map((item) => item.id),
    ["evt_1", "evt_2"],
  );
});

test("the ledger reads with no repository in sight, because it spans them all", () => {
  const output = asRecord(
    runFeedback({ args: ["list"], stateDir: seededState(), feedbackLog: "on" }),
  );

  assert.deepEqual(
    (output.items as { id: string }[]).map((item) => item.id),
    ["evt_1", "evt_2", "evt_3"],
  );
});

test("`--repo .` outside a repository says so instead of filtering by nothing", () => {
  assert.throws(
    () =>
      runFeedback({
        args: ["list", "--repo", "."],
        stateDir: seededState(),
        feedbackLog: "on",
      }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "git_repo_not_found" &&
      /--repo \./.test(error.message),
  );
});

test("list resumes after a cursor and reports when more is waiting", () => {
  const stateDir = seededState();

  const page = asRecord(feedback(["list", "--limit", "2"], stateDir));
  const next = asRecord(feedback(["list", "--cursor", String(page.cursor)], stateDir));

  assert.equal(page.cursor, "evt_2");
  assert.equal(asRecord(page.count).has_more, true);
  assert.deepEqual(
    (next.items as { id: string }[]).map((item) => item.id),
    ["evt_3"],
  );
});

test("--since accepts a duration and rejects nonsense with invalid_arguments", () => {
  const stateDir = seededState();

  const output = asRecord(feedback(["list", "--since", "2026-02-01"], stateDir));

  assert.deepEqual(
    (output.items as { id: string }[]).map((item) => item.id),
    ["evt_2", "evt_3"],
  );
  assert.doesNotThrow(() => feedback(["list", "--since", "30d"], stateDir));
  assert.throws(
    () => feedback(["list", "--since", "nonsense"], stateDir),
    (error: unknown) => error instanceof ReviewError && error.code === "invalid_arguments",
  );
});

test("--max-bytes drops whole items and says how many it held back", () => {
  const stateDir = seededState();
  const oneItem = asRecord(asRecord(feedback(["list", "--limit", "1"], stateDir)).count)
    .bytes as number;
  const budget = oneItem * 2;

  const output = asRecord(feedback(["list", "--max-bytes", String(budget)], stateDir));
  const count = asRecord(output.count);

  assert.deepEqual(
    (output.items as { id: string }[]).map((item) => item.id),
    ["evt_1", "evt_2"],
  );
  assert.equal(count.included, 2);
  assert.equal(count.omitted, 1);
  assert.equal(count.has_more, true);
  assert.equal(output.cursor, "evt_2");
  assert.ok((count.bytes as number) <= budget);
});

test("a budget too small for one item reports the omission instead of looking empty", () => {
  const output = asRecord(feedback(["list", "--max-bytes", "20"], seededState()));
  const count = asRecord(output.count);

  assert.equal(count.included, 0);
  assert.equal(count.omitted, 3);
  assert.match(JSON.stringify(output.help), /--max-bytes/);
});

test("--format jsonl prints one raw JSON object per line for bulk ingest", () => {
  const text = asText(feedback(["list", "--format", "jsonl"], seededState()));
  const lines = text.split("\n");

  assert.equal(lines.length, 3, "no trailing blank line: the CLI terminates the last one");
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { id: string }).id),
    ["evt_1", "evt_2", "evt_3"],
  );
});

test("--format md prints prompt-ready markdown sections", () => {
  const text = asText(feedback(["list", "--format", "md"], seededState()));

  assert.match(text, /^## evt_1 — src\/server\.ts \(repeated\)$/m);
  assert.match(text, /### comment/);
});

test("an empty result is a TOON empty state even when jsonl was asked for", () => {
  const output = asRecord(feedback(["list", "--format", "jsonl"], emptyState()));

  assert.equal(output.items, 0);
  assert.ok(Array.isArray(output.help));
});

test("an unknown format is rejected before any reading happens", () => {
  assert.throws(
    () => feedback(["list", "--format", "yaml"], seededState()),
    (error: unknown) => error instanceof ReviewError && error.code === "invalid_arguments",
  );
});

test("show returns one item with its patch and context in full", () => {
  const output = asRecord(feedback(["show", "evt_1"], seededState()));
  const item = asRecord(output.item);

  assert.equal(item.id, "evt_1");
  assert.equal(item.patch, "@@ -1,3 +1,4 @@ server patch");
  assert.equal(item.context, "surrounding lines");
  assert.equal(item.context_omitted, undefined, "show is the drill-down: it omits nothing");
  assert.equal(item.patch_omitted, undefined);
  assert.equal(asRecord(item.outcome).response_patch, "@@ -214,6 +214,8 @@ fixed");
  assert.ok(Array.isArray(output.help));
});

test("show of an unknown id is a structured feedback_item_unknown error", () => {
  assert.throws(
    () => feedback(["show", "evt_nope"], seededState()),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "feedback_item_unknown" &&
      error.suggestions.length > 0,
  );
});

test("show without an id says which argument is missing", () => {
  assert.throws(
    () => feedback(["show"], seededState()),
    (error: unknown) => error instanceof ReviewError && error.code === "invalid_arguments",
  );
});

test("prune removes records before a date atomically and reports the count", () => {
  const stateDir = seededState();
  const dir = feedbackDirPath(stateDir);

  const output = asRecord(feedback(["prune", "--before", "2026-02-01"], stateDir));

  assert.equal(asRecord(output.pruned).removed, 1);
  assert.deepEqual(readdirSync(dir).sort(), ["2026-02.jsonl"]);
  const remaining = readFileSync(join(dir, "2026-02.jsonl"), "utf8").trimEnd().split("\n");
  assert.ok(remaining.every((line) => JSON.parse(line) !== null));
  assert.deepEqual(
    (asRecord(feedback(["list"], stateDir)).items as { id: string }[]).map((item) => item.id),
    ["evt_2", "evt_3"],
  );
});

test("prune --repo leaves other repositories untouched", () => {
  const stateDir = seededState();

  const output = asRecord(
    feedback(["prune", "--before", "2027-01-01", "--repo", repo.root], stateDir),
  );

  assert.equal(asRecord(output.pruned).repo, repo.root);
  assert.deepEqual(
    (asRecord(feedback(["list"], stateDir)).items as { id: string }[]).map((item) => item.id),
    ["evt_3"],
  );
});

test("prune says what it removed: months, files, feedback items and the date range", () => {
  const stateDir = seededState();

  const pruned = asRecord(asRecord(feedback(["prune", "--before", "2026-02-01"], stateDir)).pruned);

  assert.equal(pruned.dry_run, false);
  assert.equal(pruned.before, "2026-02-01T00:00:00.000Z");
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.kept, 6);
  assert.equal(pruned.items_removed, 1, "annotations are the feedback a reviewer cares about");
  assert.equal(pruned.oldest_removed, "2026-01-04T09:00:00.000Z");
  assert.equal(pruned.newest_removed, "2026-01-04T09:00:00.000Z");
});

test("prune reports one row per month file, saying which file it deleted", () => {
  const stateDir = seededState();

  const output = asRecord(feedback(["prune", "--before", "2026-02-01"], stateDir));

  assert.deepEqual(output.months, [
    { month: "2026-01", removed: 1, kept: 0, file: "deleted" },
    { month: "2026-02", removed: 0, kept: 6, file: "kept" },
  ]);
});

test("--dry-run reports the same breakdown and touches nothing", () => {
  const stateDir = seededState();
  const before = readdirSync(feedbackDirPath(stateDir)).sort();

  const output = asRecord(feedback(["prune", "--before", "2026-02-01", "--dry-run"], stateDir));
  const pruned = asRecord(output.pruned);

  assert.equal(pruned.dry_run, true);
  assert.equal(pruned.removed, 1);
  assert.equal(pruned.items_removed, 1);
  assert.deepEqual(output.months, [
    { month: "2026-01", removed: 1, kept: 0, file: "deleted" },
    { month: "2026-02", removed: 0, kept: 6, file: "kept" },
  ]);
  assert.deepEqual(readdirSync(feedbackDirPath(stateDir)).sort(), before);
  assert.deepEqual(
    (asRecord(feedback(["list"], stateDir)).items as { id: string }[]).map((item) => item.id),
    ["evt_1", "evt_2", "evt_3"],
  );
  assert.match(JSON.stringify(output.help), /--dry-run/);
});

test("prune help warns that deletion is final and points at the dry run", () => {
  const help = JSON.stringify(
    asRecord(feedback(["prune", "--before", "2026-02-01"], seededState())).help,
  );

  assert.match(help, /cannot be undone|no backup/i);
});

test("a prune that matches nothing says so instead of reporting a silent zero", () => {
  const output = asRecord(feedback(["prune", "--before", "2020-01-01"], seededState()));

  assert.equal(asRecord(output.pruned).removed, 0);
  assert.match(String(output.message), /nothing/i);
  assert.deepEqual(output.months, [
    { month: "2026-01", removed: 0, kept: 1, file: "kept" },
    { month: "2026-02", removed: 0, kept: 6, file: "kept" },
  ]);
});

test("prune without --before refuses instead of guessing a date", () => {
  assert.throws(
    () => feedback(["prune"], seededState()),
    (error: unknown) => error instanceof ReviewError && error.code === "invalid_arguments",
  );
});

test("list, show and prune refuse to work against a ledger that is off", () => {
  const stateDir = seededState();

  for (const args of [["list"], ["show", "evt_1"], ["prune", "--before", "2026-02-01"]]) {
    assert.throws(
      () => feedback(args, stateDir, "off"),
      (error: unknown) => error instanceof ReviewError && error.code === "ledger_disabled",
      args.join(" "),
    );
  }
});

test("an unknown flag is a validation failure that exits 2", () => {
  assert.throws(
    () => feedback(["list", "--bogus"], seededState()),
    (error: unknown) => error instanceof Error && exitCodeForError(error) === 2,
  );
});

test("an unknown subcommand exits 2 and names the ones that exist", () => {
  assert.throws(
    () => feedback(["lst"], seededState()),
    (error: unknown) =>
      error instanceof AxiError &&
      exitCodeForError(error) === 2 &&
      /list, show, prune/.test(error.suggestions.join(" ")),
  );
});

test("a flag where a subcommand belongs exits 2 rather than being read as one", () => {
  assert.throws(
    () => feedback(["--since", "30d"], seededState()),
    (error: unknown) => error instanceof Error && exitCodeForError(error) === 2,
  );
});

test("a flag that needs a value refuses to eat the next flag", () => {
  assert.throws(
    () => feedback(["list", "--since", "--format"], seededState()),
    (error: unknown) => error instanceof ReviewError && error.code === "invalid_arguments",
  );
});
