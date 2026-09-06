import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";
import { renderGroupIndex } from "../../src/browser/group-index.ts";
import { renderProgressBar } from "../../src/browser/progress-bar.ts";
import { renderFocusBar } from "../../src/browser/focus-mode.ts";
import { trailSweeps } from "../../src/group-tier.ts";

function file(path: string): DiffFile {
  return {
    path,
    status: "modified",
    diff: `@@ -1 +1 @@\n-old\n+new ${path}`,
    insertions: 3,
    deletions: 1,
    oversized: false,
  };
}

function group(name: string, tier: DiffGroup["tier"], path: string): DiffGroup {
  return { name, rationale: `why ${name}`, tier, files: [file(path)] };
}

/** A grouping as a model hands it over: bulk wherever it happened to put it. */
const asGrouped = [
  group("Auth", "study", "src/auth.ts"),
  group("Renames", "sweep", "src/moved.ts"),
  group("Billing", "study", "src/billing.ts"),
  group("Docs", "sweep", "README.md"),
];

/** The chapter numbers a rendering names, in the order it names them. */
function chapterOrder(html: string): string[] {
  return [...html.matchAll(/data-group-index="(\d+)"/g)].map((match) => match[1]!);
}

/**
 * The invariant the ordering exists for: one order for the whole review. Both
 * surfaces read the same array, so both walk it from front to back — a chapter
 * the bar draws second is the second row of the survey, and "Chapter 2 of 4"
 * on the way into it is the same chapter again.
 */
test("the bar and the survey name the chapters in one order, and it is the array's", () => {
  const groups = trailSweeps(asGrouped);

  const bar = chapterOrder(renderProgressBar(groups, []));
  const survey = chapterOrder(renderGroupIndex(groups, []));

  assert.deepEqual(bar, ["0", "1", "2", "3"]);
  assert.deepEqual(survey, bar);
});

test("the bulk is last on both surfaces, because it is last in the array", () => {
  const groups = trailSweeps(asGrouped);

  assert.deepEqual(
    groups.map((chapter) => chapter.name),
    ["Auth", "Billing", "Renames", "Docs"],
  );
  // The lane is a heading over the tail of the array, not a second ordering:
  // the chapters inside it are the last indices, in the order they arrived.
  const survey = renderGroupIndex(groups, []);
  assert.deepEqual(
    [...survey.matchAll(/data-group-index="(\d+)"|class="(lsr-sweep)"/g)].map(
      (match) => match[1] ?? match[2],
    ),
    ["0", "1", "lsr-sweep", "2", "3"],
  );
});

test("the chapter counter counts the place the reviewer sees it drawn in", () => {
  const groups = trailSweeps(asGrouped);

  // Entering the first swept chapter is entering the third of four, which is
  // where both the bar and the survey drew it.
  assert.match(renderFocusBar(groups, 2), /Chapter 3 of 4/);
  assert.match(renderFocusBar(groups, 2), /Renames/);
});
