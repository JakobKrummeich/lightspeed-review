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
  // The name is rendered on every draw; the stylesheet shows it only while
  // the diff is up, when the card that carries it in the title size is gone.
  const html = renderFocusBar(groups, 1);

  assert.match(html, /<span class="lsr-focus-name">API<\/span>/);
  assert.match(html, /Chapter 2 of 3/);
});

test("a chapter name on the bar is escaped, never injected", () => {
  const html = renderFocusBar([group("<script>x</script>")], 0);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
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

test("a focus outside the groups renders nothing", () => {
  assert.equal(renderFocusBar(groups, 5), "");
});

test("the gate says what the chapter is for before it says what is in it", () => {
  const auth: DiffGroup = {
    name: "Auth",
    rationale: "The token expiry check moved.",
    files: [file("src/auth.ts", 12, 3)],
  };

  const html = gate(auth, "1/3 approved");

  assert.match(html, /<h2 class="lsr-gate-name">Auth<\/h2>/);
  assert.match(html, /<p class="lsr-gate-rationale">The token expiry check moved\.<\/p>/);
  // What happened reads before the files it happened to.
  assert.ok(html.indexOf("expiry check") < html.indexOf("lsr-gate-files"));
});

test("the gate lists every file of the chapter with the size of its change", () => {
  // The list is the promise the rationale is checked against: a sentence about
  // something else is caught here rather than three files into the diff.
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

test("a moved file's row shows both of its paths, and the word in place of a change of nothing", () => {
  // `src/new/thing.ts +0 −0` read as a file nobody touched; the move is the change.
  const moved = {
    ...file("src/new/thing.ts", 0, 0),
    status: "renamed" as const,
    previousPath: "src/old/thing.ts",
    similarity: 100,
  };

  const html = gate({ name: "Moves", rationale: "why Moves", files: [moved] });

  assert.match(
    html,
    /<span class="lsr-gate-path">src\/old\/thing\.ts → src\/new\/thing\.ts<\/span><span class="lsr-gate-lines">moved<\/span>/,
  );
  // The chapter's own summary line still counts lines; the row is what says the word.
  assert.doesNotMatch(html, /lsr-gate-lines">\+0 −0/);
});

test("a file moved and edited says both: the word, then the size of the edit", () => {
  const moved = {
    ...file("src/new/thing.ts", 11, 11),
    status: "renamed" as const,
    previousPath: "src/old/thing.ts",
    similarity: 44,
  };

  const html = gate({ name: "Moves", rationale: "why Moves", files: [moved] });

  assert.match(html, /<span class="lsr-gate-lines">moved · \+11 −11<\/span>/);
});

test("a rename within its directory is renamed", () => {
  const renamed = {
    ...file("src/auth/session.ts", 0, 0),
    status: "renamed" as const,
    previousPath: "src/auth/token.ts",
    similarity: 100,
  };

  const html = gate({ name: "Moves", rationale: "why Moves", files: [renamed] });

  assert.match(
    html,
    /src\/auth\/token\.ts → src\/auth\/session\.ts<\/span><span class="lsr-gate-lines">renamed<\/span>/,
  );
});

test("both paths of a moved file are escaped, never injected", () => {
  const moved = {
    ...file("src/<b>new</b>.ts", 0, 0),
    status: "renamed" as const,
    previousPath: "src/old/<i>x</i>.ts",
    similarity: 100,
  };

  const html = gate({ name: "Moves", rationale: "why Moves", files: [moved] });

  assert.doesNotMatch(html, /<b>|<i>/);
  assert.match(html, /src\/old\/&lt;i&gt;x&lt;\/i&gt;\.ts → src\/&lt;b&gt;new&lt;\/b&gt;\.ts/);
});

test("the file list is folded by default, behind one line that says how much there is", () => {
  // The count and the size say enough at a glance; the paths are for the
  // reviewer who wants to check the rationale against them, one press away.
  const html = gate({
    name: "Auth",
    rationale: "why Auth",
    files: [file("src/auth.ts", 12, 3), file("src/token.ts", 4, 0)],
  });

  assert.match(html, /<details class="lsr-gate-files">/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/, "folded until asked");
  assert.match(html, /<summary class="lsr-gate-files-summary">2 files · \+16 −3<\/summary>/);
});

test("one file is a file, not files", () => {
  const html = gate({ name: "Auth", rationale: "why Auth", files: [file("src/auth.ts", 12, 3)] });

  assert.match(html, /<summary class="lsr-gate-files-summary">1 file · \+12 −3<\/summary>/);
});

test("the rows are inside the fold, under the line that stands for them", () => {
  const html = gate({
    name: "Auth",
    rationale: "why Auth",
    files: [file("src/auth.ts", 12, 3), file("src/token.ts", 4, 0)],
  });

  const fold = /<details class="lsr-gate-files">([\s\S]*?)<\/details>/.exec(html)?.[1] ?? "";
  assert.equal(fold.match(/<li class="lsr-gate-file">/g)?.length, 2, "every row is in the fold");
  assert.ok(fold.indexOf("lsr-gate-files-summary") < fold.indexOf('<li class="lsr-gate-file">'));
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
    files: [file("<script>evil</script>.ts")],
  });

  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
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
  // on it is one press and not the reading its tier said was not worth having. The bulk is
  // last, as it reaches every reader (`trailSweeps`), so it is also where the wrap starts.
  const groups = chapters("a", "b", "c");
  groups[2] = { ...groups[2]!, tier: "sweep" };
  assert.equal(nextChapterToRead(groups, approvedIn("a", "b"), 1), 2);
  assert.equal(nextChapterToRead(groups, approvedIn("b", "c"), 2), 0);
  assert.equal(nextChapterToRead(groups, approvedIn("a", "b", "c"), 2), undefined);
});

test("a chapter with no files has nothing to read and is passed over", () => {
  const groups = [
    ...chapters("a"),
    { name: "empty", rationale: "nothing", files: [] },
    ...chapters("c"),
  ];
  assert.equal(nextChapterToRead(groups, approvedIn("a"), 0), 2);
});
