import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";
import {
  groupIndexEntries,
  indexCounterLabel,
  renderGroupIndex,
  sweepApproved,
} from "../../src/browser/group-index.ts";

function file(path: string, insertions = 3, deletions = 1): DiffFile {
  return {
    path,
    status: "modified",
    diff: `@@ -1 +1 @@\n-old\n+new ${path}`,
    insertions,
    deletions,
    oversized: false,
  };
}

function group(name: string, files: DiffFile[]): DiffGroup {
  return { name, rationale: `why ${name}`, files };
}

const groups = [
  group("Schema", [file("prisma/schema.prisma", 10, 2), file("src/db.ts", 4, 0)]),
  group("API", [file("src/api/users.ts", 7, 5)]),
];

test("an entry's counts are the group's own counts", () => {
  const entries = groupIndexEntries(groups, []);

  assert.deepEqual(entries[0], {
    name: "Schema",
    files: 2,
    insertions: 14,
    deletions: 2,
    approved: 0,
    densestLogic: false,
    sweep: false,
  });
  assert.equal(entries[1]?.files, 1);
  assert.equal(entries[1]?.insertions, 7);
});

test("entries keep the model's group order", () => {
  assert.deepEqual(
    groupIndexEntries(groups, []).map((entry) => entry.name),
    ["Schema", "API"],
  );
});

test("the counter counts approvals within the group only", () => {
  const entries = groupIndexEntries(groups, ["src/db.ts", "src/api/users.ts"]);

  assert.equal(indexCounterLabel(entries[0]!), "1/2 approved");
  assert.equal(indexCounterLabel(entries[1]!), "1/1 approved");
});

test("renders one pressable entry per group, carrying its index", () => {
  const html = renderGroupIndex(groups, []);

  const entries = html.match(/<button type="button" class="lsr-index-entry"[^>]*>/g);
  assert.equal(entries?.length, 2);
  assert.match(entries![0]!, /data-group-index="0"/);
  assert.match(entries![1]!, /data-group-index="1"/);
});

test("an entry shows file count, line counts and approvals", () => {
  const html = renderGroupIndex(groups, ["src/db.ts"]);

  assert.match(html, /2 files/);
  assert.match(html, /\+14 −2/);
  assert.match(html, /1\/2 approved/);
  assert.match(html, /1 file</);
});

test("the index singles no group out: every entry reads the same", () => {
  // A mark that says where to start moved between redraws and told the reviewer
  // nothing; the index is a plain list, and the entries carry counts only.
  const html = renderGroupIndex(groups, []);

  assert.doesNotMatch(html, /start here/);
  assert.deepEqual(
    [...html.matchAll(/<span class="lsr-index-(\w+)"/g)].map((match) => match[1]),
    // prettier-ignore
    [
      "name", "files", "lines", "counter", "logic",
      "name", "files", "lines", "counter", "logic",
    ],
  );
});

/**
 * The rule the rationale moved out under: either the reviewer should read what
 * a chapter is for, and then it must be set as though they should — which is
 * the chapter's own gate, one screen holding nothing else — or they should not,
 * and then a clamped grey line of it here is a line nobody reads twice.
 */
test("an entry says how big a chapter is, never what it is for", () => {
  const html = renderGroupIndex([group("Auth", [file("src/auth.ts")])], []);

  assert.doesNotMatch(html, /lsr-index-subtitle/);
  assert.doesNotMatch(html, /why Auth/, "the rationale is the gate's to say");
  // Nothing carries it in a tooltip either: the row is counts and a name.
  assert.doesNotMatch(html, /title=/);
  assert.match(html, /<span class="lsr-index-name">Auth<\/span>/);
});

test("a group name is escaped, never injected", () => {
  const html = renderGroupIndex([group("<script>x</script>", [file("a.ts")])], []);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("no groups is no index at all", () => {
  assert.equal(renderGroupIndex([], []), "");
});

/** A chapter of bulk: the model tiered it `sweep`, and the code agreed. */
function swept(name: string, files: DiffFile[]): DiffGroup {
  return { ...group(name, files), tier: "sweep" };
}

const mixed = [
  group("Schema", [file("src/db.ts", 4, 0)]),
  swept("Renames", [file("src/a.ts"), file("src/b.ts")]),
  swept("Docs", [file("README.md", 30, 2)]),
];

test("a review with nothing swept is the survey it has always been", () => {
  const html = renderGroupIndex(groups, []);

  assert.doesNotMatch(html, /lsr-sweep/);
  assert.equal(html.match(/lsr-index-list/g)?.length, 1);
});

test("swept chapters are collected below the studied ones, in one lane", () => {
  const html = renderGroupIndex(mixed, []);

  const order = [...html.matchAll(/data-group-index="(\d)"|class="(lsr-sweep)"/g)].map(
    (match) => match[1] ?? match[2],
  );
  // The studied chapter first, then the lane, then the two chapters inside it.
  assert.deepEqual(order, ["0", "lsr-sweep", "1", "2"]);
});

test("a chapter in the lane is pressable exactly as one above it", () => {
  const html = renderGroupIndex(mixed, ["src/a.ts"]);

  // Same button, same counts, and its own index: the lane moves rows, not the way in.
  assert.match(
    html,
    /<button type="button" class="lsr-index-entry" data-group-index="1">[\s\S]*?1\/2 approved/,
  );
  assert.equal(html.match(/class="lsr-index-entry"/g)?.length, 3);
});

test("the lane heading names the whole of what it holds", () => {
  const html = renderGroupIndex(mixed, []);

  assert.match(html, /Mechanical — 3 files, nothing to decide/);
});

test("one press approves every file in every swept chapter", () => {
  const html = renderGroupIndex(mixed, []);

  assert.match(html, /<button type="button" class="lsr-sweep-approve"[^>]*>Approve 3 files</);
});

test("the lane's press is a union, never a toggle: a second one undoes nothing", () => {
  // It is the tick the reviewer already has, in bulk. Untickng 27 files from a
  // survey row nobody meant to press twice is the one thing it must not do.
  const once = sweepApproved(mixed, ["src/db.ts"]);

  assert.deepEqual(once, ["src/db.ts", "src/a.ts", "src/b.ts", "README.md"]);
  assert.deepEqual(sweepApproved(mixed, once), once);
  // A studied chapter is never ticked from here.
  assert.deepEqual(sweepApproved(groups, []), []);
});

test("a chapter with no tier is studied, so the lane never claims an old session", () => {
  const html = renderGroupIndex([group("Docs", [file("README.md")])], []);

  assert.doesNotMatch(html, /lsr-sweep/);
});

test("a lane of one file counts in the singular", () => {
  const html = renderGroupIndex(
    [group("Schema", [file("src/db.ts")]), swept("Docs", [file("README.md")])],
    [],
  );

  assert.match(html, /Mechanical — 1 file, nothing to decide/);
  assert.match(html, />Approve 1 file</);
});

test("a review that is nothing but bulk is all lane and no empty list above it", () => {
  const html = renderGroupIndex([swept("Docs", [file("README.md")])], []);

  assert.match(html, /lsr-sweep/);
  assert.equal(html.match(/lsr-index-list/g)?.length, 1);
});

test("the lane is never where the badge points: a swept chapter wears none", () => {
  const branchy = { ...file("api/client.ts", 6, 0), diff: "@@ -1 +1,2 @@\n+  if (a) refuse();" };
  const quiet = { ...file("src/db.ts", 2, 0), diff: "@@ -1 +1 @@\n+const RETRIES = 5;" };

  const html = renderGroupIndex([group("Schema", [quiet]), swept("Generated", [branchy])], []);

  for (const mark of html.match(/<span class="lsr-index-logic"[^>]*>/g)!) {
    assert.match(mark, /hidden/);
  }
});

test("the group with the most added branching is marked, collapsed and all", () => {
  const branchy = { ...file("src/pay.ts", 6, 0), diff: "@@ -1 +1,2 @@\n+  if (a) refuse();" };
  const flat = { ...file("README.md", 2, 0), diff: "@@ -1 +1 @@\n+prose" };

  const html = renderGroupIndex([group("Docs", [flat]), group("Billing", [branchy])], []);

  const marks = html.match(/<span class="lsr-index-logic"[^>]*>/g)!;
  assert.match(marks[0]!, /hidden/);
  assert.doesNotMatch(marks[1]!, /hidden/);
});
