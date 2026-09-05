import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";
import {
  addedComplexity,
  fileComplexity,
  groupComplexity,
  heaviestFiles,
  heaviestGroups,
} from "../../src/browser/hunk-complexity.ts";

const ADDED_BRANCH = `@@ -1,3 +1,6 @@
 function pay(user) {
+  if (user.balance < 0) {
+    return refuse(user);
+  }
   return charge(user);
 }`;

const CHANGED_CONSTANT = `@@ -1,2 +1,2 @@
-const RETRIES = 3;
+const RETRIES = 5;`;

const DELETED_BRANCH = `@@ -1,6 +1,3 @@
 function pay(user) {
-  if (user.balance < 0) {
-    return refuse(user);
-  }
   return charge(user);
 }`;

/**
 * The same six lines again at four spaces instead of two: nothing decided, and
 * every branch the block already held re-added exactly as it stood.
 */
const REINDENTED = `@@ -1,6 +1,6 @@
-function pay(user) {
-  if (user.balance < 0) {
-    if (user.retries > 3 && user.flagged) {
-      return refuse(user);
-    }
-  }
+function pay(user) {
+    if (user.balance < 0) {
+        if (user.retries > 3 && user.flagged) {
+            return refuse(user);
+        }
+    }`;

function file(path: string, diff: string, overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path,
    status: "modified",
    diff,
    insertions: 1,
    deletions: 1,
    oversized: false,
    ...overrides,
  };
}

function group(name: string, files: DiffFile[]): DiffGroup {
  return { name, rationale: `why ${name}`, files };
}

function swept(name: string, files: DiffFile[]): DiffGroup {
  return { ...group(name, files), tier: "sweep" };
}

test("an added branch scores above a changed constant", () => {
  assert.ok(addedComplexity(ADDED_BRANCH) > addedComplexity(CHANGED_CONSTANT));
  assert.equal(addedComplexity(CHANGED_CONSTANT), 0);
});

test("a deleted branch scores zero: removed work is relief, not risk", () => {
  assert.equal(addedComplexity(DELETED_BRANCH), 0);
});

test("a reindented block scores nothing: it re-added the branches it removed", () => {
  assert.equal(addedComplexity(REINDENTED), 0);
});

test("a reformat never outscores a chapter that added real branching", () => {
  const groups = [
    group("Formatting", [file("src/pay.ts", REINDENTED)]),
    group("Billing", [file("src/charge.ts", ADDED_BRANCH)]),
  ];

  assert.deepEqual(heaviestGroups(groups), [1]);
});

test("a swept chapter never wears the badge, whatever it scores", () => {
  const groups = [
    swept("Generated clients", [file("api/client.ts", ADDED_BRANCH)]),
    group("Billing", [file("src/pay.ts", `@@ -1 +1,2 @@\n+if (a) run();`)]),
  ];

  assert.deepEqual(heaviestGroups(groups), [1]);
  assert.deepEqual(heaviestGroups([groups[0]!]), []);
});

test("deeper added branching outscores the same branch at the top level", () => {
  const shallow = `@@ -1 +1,2 @@\n+if (a) run();`;
  const deep = `@@ -1 +1,2 @@\n+      if (a) run();`;

  assert.ok(addedComplexity(deep) > addedComplexity(shallow));
});

test("depth counts once, so a long flat block is long and not deep", () => {
  const oneLine = `@@ -1 +1,2 @@\n+  if (a) run();`;
  const manyLines = `@@ -1 +1,4 @@\n+  if (a) run();\n+  step();\n+  step();`;

  assert.equal(addedComplexity(manyLines), addedComplexity(oneLine));
});

test("symbolic branches count too", () => {
  assert.ok(addedComplexity(`@@ -1 +1 @@\n+const x = a ?? b && c;`) > 0);
});

test("the file header line is not mistaken for added code", () => {
  assert.equal(addedComplexity(`+++ b/src/if-else/for.ts\n --- a/x`), 0);
});

test("a binary file scores nothing at all", () => {
  assert.equal(fileComplexity(file("logo.png", "", { status: "binary" })), 0);
});

test("the heaviest file of a group is the one that marks", () => {
  const heavy = file("src/pay.ts", ADDED_BRANCH);
  const light = file("src/const.ts", CHANGED_CONSTANT);

  assert.deepEqual(heaviestFiles(group("Billing", [light, heavy])), ["src/pay.ts"]);
});

test("a group that added no branching marks nothing", () => {
  const only = group("Formatting", [file("a.ts", CHANGED_CONSTANT), file("b.ts", DELETED_BRANCH)]);

  assert.equal(groupComplexity(only), 0);
  assert.deepEqual(heaviestFiles(only), []);
});

test("equally heavy files both mark rather than one being picked", () => {
  const both = group("Billing", [file("a.ts", ADDED_BRANCH), file("b.ts", ADDED_BRANCH)]);

  assert.deepEqual(heaviestFiles(both), ["a.ts", "b.ts"]);
});

test("the index marks the group holding the most added branching", () => {
  const groups = [
    group("Formatting", [file("a.ts", CHANGED_CONSTANT)]),
    group("Billing", [file("b.ts", ADDED_BRANCH)]),
  ];

  assert.deepEqual(heaviestGroups(groups), [1]);
  assert.deepEqual(heaviestGroups([groups[0]!]), []);
});
