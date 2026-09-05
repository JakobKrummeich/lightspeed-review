import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";
import {
  progressSegments,
  renderProgressBar,
  segmentFillStyle,
  segmentGrow,
  segmentLabel,
} from "../../src/browser/progress-bar.ts";

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

test("a segment is worth the lines its group changed, and counts the files the index counts", () => {
  const [schema, api] = progressSegments(groups, []);

  assert.equal(schema?.name, "Schema");
  assert.equal(schema?.files, 2);
  assert.equal(schema?.approved, 0);
  assert.equal(schema?.weight, 16);
  assert.equal(schema?.approvedWeight, 0);
  assert.equal(schema?.state, "untouched");
  assert.equal(api?.weight, 12);
});

test("segments keep the model's group order", () => {
  assert.deepEqual(
    progressSegments(groups, []).map((segment) => segment.name),
    ["Schema", "API"],
  );
});

test("a file that changed no lines the diff can count is still worth reading", () => {
  const binary = [group("Art", [{ ...file("logo.png", 0, 0), status: "binary" as const }])];

  assert.equal(progressSegments(binary, [])[0]?.weight, 1);
});

test("the fill follows the lines approved, not the files", () => {
  const segments = progressSegments(groups, ["src/db.ts"]);

  assert.equal(segments[0]?.approvedWeight, 4);
  assert.equal(segments[0]?.approved, 1);
  assert.equal(segmentFillStyle(segments[0]!), "width: 25%");
});

test("a group is only full when every file in it is ticked", () => {
  const partly = progressSegments(groups, ["prisma/schema.prisma"]);
  assert.equal(partly[0]?.state, "partial");
  assert.equal(partly[1]?.state, "untouched");

  const done = progressSegments(groups, ["prisma/schema.prisma", "src/db.ts"]);
  assert.equal(done[0]?.state, "approved");
  assert.equal(segmentFillStyle(done[0]!), "width: 100%");
});

test("a group with no files in it fills nothing rather than dividing by its own weight", () => {
  // Unproducible by a grouping (`llm/schema.ts` wants ≥1 file per group), but the arithmetic
  // answers for itself: a zero-weight segment must be an empty slot, not `NaN%`.
  const segments = progressSegments([group("Empty", []), ...groups], []);

  assert.equal(segments[0]?.state, "untouched");
  assert.equal(segments[0]?.weight, 0);
  assert.equal(segmentFillStyle(segments[0]!), "width: 0%");
});

test("a segment says which group it is, in the wording the index counts in", () => {
  const segment = progressSegments(groups, ["src/db.ts"])[0]!;

  assert.equal(segmentLabel(segment), "Schema: 1/2 approved");
});

test("renders one segment per group, carrying its index and its share of the work", () => {
  const html = renderProgressBar(groups, []);

  assert.equal(html.match(/class="lsr-progress-segment"/g)?.length, 2);
  assert.match(html, /data-group-index="0"[^>]*style="flex-grow: 4"/);
  assert.match(html, /data-group-index="1"[^>]*style="flex-grow: 3.46"/);
});

test("the bar states how many segments share it, which is what caps their floor", () => {
  // The pressable floor is min(2rem, an equal share); CSS can only work the share out from a
  // count the markup hands it.
  assert.match(
    renderProgressBar(groups, []),
    /class="lsr-progress-bar"[^>]*--lsr-progress-segments: 2/,
  );
});

test("a chapter ten times the size is drawn about three times the width, not ten", () => {
  // Linear weight gave a 290-line rename nine tenths of the bar and left the 31-line chapter
  // that carried the logic a sliver. The order survives the root; the ratio is compressed.
  assert.equal(segmentGrow(400), 20);
  assert.equal(segmentGrow(40), 6.32);
  // A group with nothing measurable in it is still a press, never a zero-width segment.
  assert.equal(segmentGrow(0), 1);
});

test("the bar states each group's state, and names it for a pointer and a screen reader", () => {
  const html = renderProgressBar(groups, ["src/db.ts", "src/api/users.ts"]);

  assert.match(html, /data-state="partial"[^>]*title="Schema: 1\/2 approved"/);
  assert.match(html, /aria-label="Schema: 1\/2 approved"/);
  assert.match(html, /data-state="approved"[^>]*title="API: 1\/1 approved"/);
});

test("a group named in markup's own characters cannot break out of the bar", () => {
  const html = renderProgressBar([group(`Quotes "&" <b>`, [file("a.ts")])], []);

  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /title="Quotes &quot;&amp;&quot; &lt;b&gt;: 0\/1 approved"/);
});

test("the exact count stands next to the bar, in files", () => {
  assert.match(
    renderProgressBar(groups, ["src/db.ts"]),
    /<span class="lsr-progress-count">1\/3 files approved<\/span>/,
  );
});

test("a review with nothing in it says so instead of drawing an empty bar", () => {
  // Same reading of "nothing" as the count beside it: files in any group, not groups.
  for (const empty of [[], [group("Empty", [])]]) {
    const html = renderProgressBar(empty, []);

    assert.doesNotMatch(html, /lsr-progress-bar/);
    assert.match(html, /nothing to review/);
  }
});

/** The same two chapters, with the second one tiered as bulk. */
const tiered = [groups[0]!, { ...groups[1]!, tier: "sweep" as const }];

test("a swept chapter is marked on the bar, and a studied one is not", () => {
  const html = renderProgressBar(tiered, []);

  assert.doesNotMatch(html, /data-group-index="0"[^>]*data-tier/);
  assert.match(html, /data-group-index="1"[^>]*data-tier="sweep"/);
  // The mark is a state of the segment, not a second kind of element.
  assert.equal(html.match(/class="lsr-progress-segment"/g)?.length, 2);
});

test("the mark reaches a reviewer who cannot see the hatching", () => {
  const [study, sweep] = progressSegments(tiered, []);

  assert.equal(segmentLabel(study!), "Schema: 0/2 approved");
  assert.equal(segmentLabel(sweep!), "API: 0/1 approved, mechanical");
});

test("a chapter with no tier is drawn as one to read", () => {
  // Every session written before tiers existed is this shape.
  assert.doesNotMatch(renderProgressBar(groups, []), /data-tier/);
});

test("the chapter being read carries the mark, and only that one", () => {
  const html = renderProgressBar(groups, [], 1);

  assert.match(html, /data-group-index="1"[^>]*data-current="true"/);
  assert.doesNotMatch(html, /data-group-index="0"[^>]*data-current/);
});

test("the survey marks no segment: nothing is being read yet", () => {
  assert.doesNotMatch(renderProgressBar(groups, []), /data-current/);
});

test("a segment is a press that names its chapter, not a picture of it", () => {
  // Each segment is also the fastest way into its chapter, so it renders as a real button;
  // the label already tells a screen reader what it is, and `role="img"` would take the button away.
  const html = renderProgressBar(groups, [], 1);

  assert.match(html, /<button type="button" class="lsr-progress-segment" data-group-index="0"/);
  assert.doesNotMatch(html, /role="img"/);
});
