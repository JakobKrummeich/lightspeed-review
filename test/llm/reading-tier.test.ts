import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";
import type { GroupTier } from "../../src/group-tier.ts";
import { raiseToStudy } from "../../src/llm/reading-tier.ts";

function file(path: string, diff = "@@ -1 +1 @@\n-old\n+new"): DiffFile {
  return { path, status: "modified", diff, insertions: 1, deletions: 1, oversized: false };
}

function group(tier: GroupTier, files: DiffFile[]): DiffGroup {
  return { name: "Chapter", rationale: "why", watch: "what", tier, files };
}

function tiersOf(groups: DiffGroup[]): (GroupTier | undefined)[] {
  return raiseToStudy(groups).map((group) => group.tier);
}

test("a swept chapter of nothing but bulk stays swept", () => {
  const groups = [group("sweep", [file("README.md"), file("docs/setup.mdx"), file("web/a.css")])];

  assert.deepEqual(tiersOf(groups), ["sweep"]);
});

test("one file no rule calls mechanical raises the whole chapter", () => {
  // The chapter is the unit: one file to judge is a chapter to read, and the
  // other twenty-six ride along rather than hiding it.
  const groups = [group("sweep", [file("README.md"), file("src/auth.ts")])];

  assert.deepEqual(tiersOf(groups), ["study"]);
});

test("a guardrail file raises a chapter its own diff says is bulk", () => {
  // Whitespace-only, so the mechanical rules would claim it; a deploy script
  // whose whole change is re-indentation is still a deploy script.
  const reindented = file("scripts/deploy.sh", "@@ -1 +1 @@\n-  run()\n+    run()");

  assert.deepEqual(tiersOf([group("sweep", [file("README.md"), reindented])]), ["study"]);
});

test("study is never lowered, however mechanical every file in it looks", () => {
  // The asymmetry, stated as a test: automation may add reading, never remove
  // it. A chapter wrongly swept is the change nobody looked at.
  const groups = [group("study", [file("README.md"), file("locale/de.po")])];

  assert.deepEqual(tiersOf(groups), ["study"]);
});

test("a chapter that arrived without a tier leaves as study", () => {
  const untiered: DiffGroup = {
    name: "Tests",
    rationale: "the checks",
    files: [file("README.md")],
  };

  assert.deepEqual(tiersOf([untiered]), ["study"]);
});

test("the repository's own globs raise and sweep alongside the defaults", () => {
  const classify = { mechanical: ["src/generated/**"], guardrail: ["config/secrets.yml"] };
  const generated = [group("sweep", [file("src/generated/api.ts")])];
  const secret = [group("sweep", [file("README.md"), file("config/secrets.yml")])];

  assert.deepEqual(
    raiseToStudy(generated, classify).map((g) => g.tier),
    ["sweep"],
  );
  assert.deepEqual(
    raiseToStudy(secret, classify).map((g) => g.tier),
    ["study"],
  );
});

test("every chapter comes back tiered, and nothing else about it is touched", () => {
  const groups = [group("sweep", [file("README.md")]), group("sweep", [file("src/auth.ts")])];

  const raised = raiseToStudy(groups);

  assert.deepEqual(
    raised.map((one) => one.tier),
    ["sweep", "study"],
  );
  assert.deepEqual(
    raised.map((one) => ({ name: one.name, rationale: one.rationale, watch: one.watch })),
    [
      { name: "Chapter", rationale: "why", watch: "what" },
      { name: "Chapter", rationale: "why", watch: "what" },
    ],
  );
  assert.deepEqual(raised[0]?.files, groups[0]?.files);
  // Pure: the caller's own groups are not rewritten under it.
  assert.deepEqual(
    groups.map((one) => one.tier),
    ["sweep", "sweep"],
  );
});
