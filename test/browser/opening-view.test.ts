import { test } from "node:test";
import assert from "node:assert/strict";
import { opensFor, renderOpening } from "../../src/browser/opening-view.ts";

/** The sheets of the stack, whole, in the order the markup lays them down. */
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
  assert.deepEqual(texts(html, "lsr-opening-body").slice(1), [
    "replace session cookies with signed tokens",
    "drop the legacy /login handler",
    "prove the whole thing with tests",
  ]);
});

test("the cover says who it is from and how much there is", () => {
  const html = renderOpening(["one", "two", "three", "four"]);
  const cover = sheets(html)[0] ?? "";

  assert.match(cover, /from your agent/);
  assert.match(cover, /Something was built for you/);
  assert.match(cover, /Four reasons, one at a time\./);
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

test("each sheet says which kind it is, so the cover can speak at a size the reasons do not", () => {
  const kinds = sheets(renderOpening(["one", "two"])).map((sheet) =>
    attribute(sheet, "data-sheet"),
  );

  assert.deepEqual(kinds, ["cover", "reason", "reason"]);
});

test("a single reason is spoken of as one reason, not as one reasons", () => {
  const html = renderOpening(["sign the tokens"]);

  assert.match(html, /One reason, one at a time\./);
  assert.doesNotMatch(html, /reasons/);
});

test("a count past the spelled numbers is still said, in digits", () => {
  const html = renderOpening(Array.from({ length: 9 }, (_unused, index) => `reason ${index}`));

  assert.match(html, /9 reasons, one at a time\./);
});

test("each reason says which of how many it is, to whoever cannot see the dots", () => {
  // The counter costs no pixels now: it is the reason section's own label, so
  // a screen reader still hears how far through the stack it is.
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

test("the motes are a field of fourteen, and the same field every time it is drawn", () => {
  const html = renderOpening(["one"]);
  const motes = [...html.matchAll(/<i class="lsr-opening-mote" style="([^"]*)"><\/i>/g)].map(
    ([, style]) => style ?? "",
  );

  assert.equal(motes.length, 14);
  assert.equal(new Set(motes).size, 14, "fourteen motes in one place is one mote");
  // A render nobody can predict is a render nobody can test, and randomness
  // here would redraw the field differently on every call.
  assert.equal(renderOpening(["one"]), html);
});

test("every mote is inside the room, already drifting, and drifting somewhere", () => {
  const styles = [...renderOpening(["one"]).matchAll(/class="lsr-opening-mote" style="([^"]*)"/g)];

  for (const [, style = ""] of styles) {
    const left = Number(/left:([\d.]+)%/.exec(style)?.[1]);
    const life = Number(/--life:([\d.]+)s/.exec(style)?.[1]);
    const delay = Number(/--delay:(-?[\d.]+)s/.exec(style)?.[1]);
    const drift = Number(/--drift:(-?\d+)px/.exec(style)?.[1]);

    assert.ok(left >= 8 && left <= 92, `a mote at ${left}% is up against the wall`);
    assert.ok(life >= 7 && life <= 14, `a mote living ${life}s is not drifting`);
    // Negative, so the field is full on the first frame rather than filling up
    // while the cover is being read.
    assert.ok(delay <= 0 && delay >= -life, `a mote delayed ${delay}s arrives late`);
    assert.ok(Math.abs(drift) <= 30, `a mote drifting ${drift}px crosses the room`);
  }
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

/** The one review that opens: everything else below is one field off it. */
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
