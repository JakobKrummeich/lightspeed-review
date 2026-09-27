import { test } from "node:test";
import assert from "node:assert/strict";
import { opensFor, renderOpening, renderSkyNames } from "../../src/browser/opening-view.ts";

function sheets(html: string): string[] {
  return [...html.matchAll(/<section class="lsr-opening-sheet"[\s\S]*?<\/section>/g)].map(
    ([sheet]) => sheet,
  );
}

function texts(html: string, className: string): string[] {
  const pattern = new RegExp(`<p class="${className}">([\\s\\S]*?)</p>`, "g");
  return [...html.matchAll(pattern)].map(([, text]) => text ?? "");
}

function buttons(html: string): string[] {
  return [...html.matchAll(/<button[^>]*class="lsr-opening-press"[^>]*>([\s\S]*?)<\/button>/g)].map(
    ([, label]) => label ?? "",
  );
}

function attribute(sheet: string, name: string): string {
  return new RegExp(`${name}="([^"]*)"`).exec(sheet)?.[1] ?? "";
}

test("the stack is the cover and then one sheet per reason, in the order given", () => {
  const html = renderOpening([
    "replace session cookies with signed tokens",
    "drop the legacy /login handler",
    "prove the whole thing with tests",
  ]);

  assert.equal(sheets(html).length, 4, "three reasons are three sheets, behind one cover");
  assert.deepEqual(texts(html, "lsr-opening-body"), [
    "replace session cookies with signed tokens",
    "drop the legacy /login handler",
    "prove the whole thing with tests",
  ]);
});

test("the cover says who it is from and that there is something, and no more", () => {
  const html = renderOpening(["one", "two", "three", "four"]);
  const cover = sheets(html)[0] ?? "";

  assert.match(cover, /from your agent/);
  assert.match(cover, /Something was built for you/);
  assert.deepEqual(buttons(cover), ["Unwrap"]);
});

test("the cover does not count the reasons: the dots say how many, the sheets say what", () => {
  // "Four reasons, one at a time." was a line to read before the reasons could
  // be; a cover with nothing to say has no body element, rather than an empty
  // paragraph the stylesheet would still lay out.
  const cover = sheets(renderOpening(["one", "two", "three", "four"]))[0] ?? "";

  assert.doesNotMatch(cover, /reason/);
  assert.doesNotMatch(cover, /at a time/);
  assert.doesNotMatch(cover, /lsr-opening-body/);
});

test("a reason sheet carries the reason and the way on, and nothing else", () => {
  // Everything the room does not need is off it: the lead line said the same
  // thing on every sheet, and the counter said what the dots already show.
  const reason = sheets(renderOpening(["one", "two"]))[1] ?? "";

  assert.doesNotMatch(reason, /lsr-opening-lead/);
  assert.doesNotMatch(reason, /what this change is for/);
  assert.doesNotMatch(renderOpening(["one", "two"]), /lsr-opening-count/);
  assert.deepEqual(texts(reason, "lsr-opening-body"), ["one"]);
});

test("each reason says which of how many it is, to whoever cannot see the dots", () => {
  // The counter is the reason section's own label, so a screen reader still
  // hears how far through the stack it is.
  const labels = sheets(renderOpening(["one", "two", "three"])).map((sheet) =>
    attribute(sheet, "aria-label"),
  );

  assert.deepEqual(labels, ["", "reason 1 of 3", "reason 2 of 3", "reason 3 of 3"]);
});

test("the room is opaque and starts unlit: no flare, no bloom, until a press asks for one", () => {
  const html = renderOpening(["one"]);

  assert.match(html, /class="lsr-opening-overlay"/);
  assert.match(html, /data-flare="false"/);
  assert.match(html, /data-bloom="false"/);
  assert.match(html, /<span class="lsr-opening-bloom" aria-hidden="true"><\/span>/);
});

test("the stars are one decorative canvas, not markup: no motes, nothing a reader hears", () => {
  const html = renderOpening(["one"]);

  assert.match(html, /<canvas class="lsr-sky-canvas" aria-hidden="true"><\/canvas>/);
  assert.match(html, /<div class="lsr-sky-names" aria-hidden="true" data-on="false"><\/div>/);
  assert.doesNotMatch(html, /lsr-opening-mote/);
  assert.match(html, /data-jump="false"/, "the room starts before the jump, not in it");
});

const CHAPTERS = [
  { name: "Session state", files: [{ path: "src/state.ts", lines: 40 }] },
  { name: "Docs <b>", files: [{ path: "README.md", lines: 2 }] },
];

test("with chapters, the constellation sheet comes last, after every reason", () => {
  const stack = sheets(renderOpening(["one", "two"], CHAPTERS));

  assert.equal(stack.length, 4, "cover, two reasons, the sky");
  assert.deepEqual(
    stack.map((sheet) => attribute(sheet, "data-sky")),
    ["", "", "", "true"],
  );
});

test("the constellation sheet has no words on it, only the way into the review", () => {
  const sky = sheets(renderOpening(["one"], CHAPTERS)).at(-1) ?? "";

  assert.doesNotMatch(sky, /<p /, "no intent, no headline, no lead");
  assert.deepEqual(buttons(sky), ["Open the review"]);
});

test("the sky's button starts held back, and the sheet can hold the caret meanwhile", () => {
  const sky = sheets(renderOpening(["one"], CHAPTERS)).at(-1) ?? "";

  assert.match(sky, /<button type="button" class="lsr-opening-press" data-held="true">/);
  assert.match(sky, /tabindex="-1"/);
  const others = sheets(renderOpening(["one"], CHAPTERS))
    .slice(0, -1)
    .join("");
  assert.doesNotMatch(others, /data-held/, "only the sky holds its button back");
});

test("the last reason leads to the chapters when there is a sky to show", () => {
  assert.deepEqual(buttons(renderOpening(["one", "two"], CHAPTERS)), [
    "Unwrap",
    "Next reason",
    "Show the chapters",
    "Open the review",
  ]);
});

test("a reader who cannot see the sky hears the chapters in the sheet's label, escaped", () => {
  const sky = sheets(renderOpening(["one"], CHAPTERS)).at(-1) ?? "";

  assert.equal(attribute(sky, "aria-label"), "2 chapters: Session state, Docs &lt;b&gt;");
});

test("each name stands where the layout put it, with its file count, and is text only", () => {
  const html = renderSkyNames([
    { chapter: 0, name: "Docs <b>", files: 1, x: 120.04, y: 80.5, width: 90, height: 34 },
    { chapter: 1, name: "Session state", files: 12, x: 300, y: 40, width: 120, height: 34 },
  ]);

  assert.equal(
    html,
    '<span class="lsr-sky-name" style="left:120.0px;top:80.5px;max-width:90px"><span class="lsr-sky-title">Docs &lt;b&gt;</span><small class="lsr-sky-count">1 file</small></span>' +
      '<span class="lsr-sky-name" style="left:300.0px;top:40.0px;max-width:120px"><span class="lsr-sky-title">Session state</span><small class="lsr-sky-count">12 files</small></span>',
  );
  assert.equal(renderSkyNames([]), "");
});

test("the last sheet opens the review and every sheet before it moves on", () => {
  const html = renderOpening(["one", "two", "three"]);

  assert.deepEqual(buttons(html), ["Unwrap", "Next reason", "Next reason", "Open the review"]);
});

test("a round with one reason opens the review from its only reason", () => {
  assert.deepEqual(buttons(renderOpening(["sign the tokens"])), ["Unwrap", "Open the review"]);
});

test("the cover is on top and everything else is under it, in the markup already", () => {
  const html = renderOpening(["one", "two"]);
  const stack = sheets(html);

  assert.deepEqual(
    stack.map((sheet) => attribute(sheet, "data-index")),
    ["0", "1", "2"],
  );
  assert.deepEqual(
    stack.map((sheet) => attribute(sheet, "data-at")),
    ["top", "under", "under"],
  );
});

test("a dot per sheet, the first of them lit", () => {
  const html = renderOpening(["one", "two"]);
  const dots = [...html.matchAll(/<i class="lsr-opening-dot" data-on="(\w+)"><\/i>/g)].map(
    ([, on]) => on,
  );

  assert.deepEqual(dots, ["true", "false", "false"]);
});

test("a reason is text, never markup: a page that runs it has lost the review", () => {
  const html = renderOpening(["<script>alert('x')</script> & <b>bold</b>"]);

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>bold/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test("a round that stated no reason has nothing to unwrap", () => {
  assert.equal(renderOpening([]), "");
});

const FIRST_ROUND = {
  round: 0,
  intents: ["sign the tokens"],
  ended: false,
  unwrapped: false,
};

test("a first round that states a reason is what the ceremony is for", () => {
  assert.equal(opensFor(FIRST_ROUND), true);
});

test("a later round keeps the replay it has and gets no wrapper", () => {
  assert.equal(opensFor({ ...FIRST_ROUND, round: 1 }), false);
});

test("a round opened without a reason has no sheet to show", () => {
  assert.equal(opensFor({ ...FIRST_ROUND, intents: [] }), false);
});

test("an ended review is read, not handed over", () => {
  assert.equal(opensFor({ ...FIRST_ROUND, ended: true }), false);
});

test("once opened it never opens again, however the reviewer left it", () => {
  assert.equal(opensFor({ ...FIRST_ROUND, unwrapped: true }), false);
});
