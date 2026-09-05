import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";
import {
  clampFocus,
  nextChapterToRead,
  renderChapterGate,
  renderFocusBar,
} from "../../src/browser/focus-mode.ts";

function file(path: string, insertions = 1, deletions = 1): DiffFile {
  return {
    path,
    status: "modified",
    diff: `@@ -1 +1 @@\n-old\n+new ${path}`,
    insertions,
    deletions,
    oversized: false,
  };
}

function group(name: string): DiffGroup {
  return { name, rationale: `why ${name}`, files: [file(`src/${name}.ts`)] };
}

/** A gate drawn for one chapter, with everything not under test at its quietest. */
function gate(group: DiffGroup, counter = "0/1 approved"): string {
  return renderChapterGate({ group, contentId: "lsr-group-content-0", counter });
}

const groups = [group("Schema"), group("API"), group("Docs")];

test("a chapter the review has is kept", () => {
  assert.equal(clampFocus(0, 3), 0);
  assert.equal(clampFocus(2, 3), 2);
});

test("a chapter the review does not have is no focus at all", () => {
  // A stored index can outlive the grouping it pointed into; focusing a
  // chapter that is not there would render an empty review.
  assert.equal(clampFocus(3, 3), undefined);
  assert.equal(clampFocus(-1, 3), undefined);
  assert.equal(clampFocus(1.5, 3), undefined);
  assert.equal(clampFocus(undefined, 3), undefined);
  assert.equal(clampFocus(0, 0), undefined);
});

test("the bar names the chapter and its place in the review", () => {
  const html = renderFocusBar(groups, 1);

  assert.match(html, /<span class="lsr-focus-name">API<\/span>/);
  assert.match(html, /Chapter 2 of 3/);
});

test("the bar carries the way out and the way sideways", () => {
  const html = renderFocusBar(groups, 1);

  assert.match(html, /class="lsr-focus-exit"/);
  assert.match(html, /class="lsr-focus-prev"/);
  assert.match(html, /class="lsr-focus-next"/);
});

test("the first chapter has no previous, the last no next", () => {
  assert.match(renderFocusBar(groups, 0), /class="lsr-focus-prev"[^>]*disabled/);
  assert.doesNotMatch(renderFocusBar(groups, 0), /class="lsr-focus-next"[^>]*disabled/);
  assert.match(renderFocusBar(groups, 2), /class="lsr-focus-next"[^>]*disabled/);
  assert.doesNotMatch(renderFocusBar(groups, 2), /class="lsr-focus-prev"[^>]*disabled/);
});

test("a chapter name is escaped, never injected", () => {
  const html = renderFocusBar([group("<script>x</script>")], 0);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("a focus outside the groups renders nothing", () => {
  assert.equal(renderFocusBar(groups, 5), "");
});

test("the gate says what the chapter is for before it says what is in it", () => {
  const auth: DiffGroup = {
    name: "Auth",
    rationale: "The token expiry check moved.",
    watch: "The retry loop exit is new.",
    files: [file("src/auth.ts", 12, 3)],
  };

  const html = gate(auth, "1/3 approved");

  assert.match(html, /<h2 class="lsr-gate-name">Auth<\/h2>/);
  assert.match(html, /<p class="lsr-gate-rationale">The token expiry check moved\.<\/p>/);
  assert.match(html, /<p class="lsr-gate-watch">The retry loop exit is new\.<\/p>/);
  // What happened reads before what to watch for, and both before the files.
  assert.ok(html.indexOf("expiry check") < html.indexOf("retry loop"));
  assert.ok(html.indexOf("retry loop") < html.indexOf("lsr-gate-files"));
});

test("the gate lists every file of the chapter with the size of its change", () => {
  // The list is the promise the two sentences are checked against: a rationale
  // about something else is caught here rather than three files into the diff.
  const html = gate({
    name: "Auth",
    rationale: "why Auth",
    files: [file("src/auth.ts", 12, 3), file("src/token.ts", 4, 0)],
  });

  assert.match(
    html,
    /<span class="lsr-gate-path">src\/auth\.ts<\/span><span class="lsr-gate-lines">\+12 −3<\/span>/,
  );
  assert.match(html, /<span class="lsr-gate-path">src\/token\.ts<\/span>/);
  assert.match(html, /\+4 −0/);
});

test("the gate carries the chapter's counter, worded as every other counter is", () => {
  assert.match(
    gate(group("API"), "1/3 approved"),
    /<p class="lsr-gate-counter">1\/3 approved<\/p>/,
  );
});

test("the press is a real button that names the region it reveals", () => {
  // Same discipline the group header had: the diff is rendered and shut, and
  // the button that opens it says so to anything reading the page aloud.
  const html = gate(group("API"));

  assert.match(
    html,
    /<button type="button" class="lsr-gate-press" aria-expanded="false" aria-controls="lsr-group-content-0">Read the diff<\/button>/,
  );
});

test("a chapter without a watch sentence gets none: absence is honest", () => {
  const html = gate(group("API"));

  assert.doesNotMatch(html, /lsr-gate-watch/);
  assert.doesNotMatch(html, /undefined/);
});

test("a sweep chapter's card says why it offers its tick, in the survey's words", () => {
  const html = gate({ ...group("Docs"), tier: "sweep" });

  assert.match(html, /<p class="lsr-gate-tier">Mechanical — nothing to decide<\/p>/);
  // A label on the chapter, under its name and before the sentences about it.
  assert.ok(html.indexOf("lsr-gate-name") < html.indexOf("lsr-gate-tier"));
  assert.ok(html.indexOf("lsr-gate-tier") < html.indexOf("lsr-gate-rationale"));
});

test("a study chapter's card wears no tier label: reading is the default", () => {
  assert.doesNotMatch(gate(group("API")), /lsr-gate-tier/);
  assert.doesNotMatch(gate({ ...group("API"), tier: "study" }), /lsr-gate-tier/);
});

test("every word the grouping wrote is escaped, never injected", () => {
  const html = gate({
    name: "<script>x</script>",
    rationale: "<img onerror=x>",
    watch: "<b>watch</b>",
    files: [file("<script>evil</script>.ts")],
  });

  assert.doesNotMatch(html, /<script>|<img|<b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;b&gt;/);
});

/** Chapters in reading order, each one file, named by letter so the approved list reads easily. */
function chapters(...names: string[]): DiffGroup[] {
  return names.map((name) => group(name));
}

const approvedIn = (...names: string[]): string[] => names.map((name) => `src/${name}.ts`);

test("finishing a chapter moves on to the next one still to read", () => {
  assert.equal(nextChapterToRead(chapters("a", "b", "c"), approvedIn("a"), 0), 1);
});

test("a chapter already approved is passed over on the way to the next", () => {
  assert.equal(nextChapterToRead(chapters("a", "b", "c"), approvedIn("a", "b"), 0), 2);
});

test("the last chapter finished wraps round to the first still unread", () => {
  assert.equal(nextChapterToRead(chapters("a", "b", "c"), approvedIn("b", "c"), 2), 0);
});

test("nothing left to read is nowhere to go, and never the chapter just finished", () => {
  assert.equal(nextChapterToRead(chapters("a", "b"), approvedIn("a", "b"), 1), undefined);
  assert.equal(nextChapterToRead(chapters("a"), approvedIn("a"), 0), undefined);
});

test("a sweep chapter is landed on like any other: its card takes the tick without the diff", () => {
  // The reviewer settles every chapter in order; a sweep's card offers its tick, so landing
  // on it is one press and not the reading its tier said was not worth having.
  const groups = chapters("a", "b", "c");
  groups[1] = { ...groups[1]!, tier: "sweep" };
  assert.equal(nextChapterToRead(groups, approvedIn("a"), 0), 1);
  assert.equal(nextChapterToRead(groups, approvedIn("a", "c"), 2), 1);
  assert.equal(nextChapterToRead(groups, approvedIn("a", "b", "c"), 1), undefined);
});

test("a chapter with no files has nothing to read and is passed over", () => {
  const groups = [
    ...chapters("a"),
    { name: "empty", rationale: "nothing", files: [] },
    ...chapters("c"),
  ];
  assert.equal(nextChapterToRead(groups, approvedIn("a"), 0), 2);
});
