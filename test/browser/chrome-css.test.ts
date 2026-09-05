import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stylesheet } from "../helpers/stylesheet.ts";

// The whole stylesheet, however many files it is split into: these assertions
// are about what the browser is served, not about where a rule is written.
const css = stylesheet();
const lines = css.split("\n");
const shell = readFileSync(new URL("../../src/html-template.ts", import.meta.url), "utf8");

test("both schemes exist and an explicit pick can reach either", () => {
  assert.match(css, /:root\[data-color-scheme="light"\][\s\S]*?color-scheme: light;/);
  assert.match(css, /:root\[data-color-scheme="dark"\][\s\S]*?color-scheme: dark;/);
  // Without this the page could not follow the OS before a pick is made.
  assert.match(css, /color-scheme: light dark;/);
});

test("every colour is a token or built from one", () => {
  // Colour literals may appear only in token definitions; everything else must use var()/color-mix().
  const declarations = /--lsr-[\w-]*:[^;]*;/g;
  const stray = css
    .replace(declarations, "")
    .split("\n")
    .filter((line) => /#[0-9a-fA-F]{3,8}\b|\b(?:oklch|rgb|hsl)\(/.test(line));

  assert.deepEqual(stray, [], `hard-coded colours outside the tokens:\n${stray.join("\n")}`);
});

test("code tokens are painted from the palette too", () => {
  // No highlight.js theme is shipped: token classes must be styled here or code fights the diff colours.
  for (const token of [".hljs-comment", ".hljs-keyword", ".hljs-string", ".hljs-title"]) {
    assert.match(css, new RegExp(`\\${token}\\b`), `${token} is left to highlight.js`);
  }
  // A theme background on `.hljs` would cover the line's added/removed background.
  assert.match(css, /\.hljs\b[^{]*\{[^}]*background: none;/);
});

test("token colours come from the code tokens, not straight from a hue", () => {
  // `--lsr-code-*` tokens map hues to syntax roles; reaching for `--lsr-green` directly ties a syntax role to a chip colour.
  const rules = [...css.matchAll(/([^{}]*\.hljs[\w-]*[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 5, "expected the highlight.js rules to be found");

  const raw = rules.filter(([, , body]) =>
    /color:[^;]*var\(--lsr-(green|red|amber|violet|pink|cyan|accent)\)/.test(body ?? ""),
  );

  assert.deepEqual(
    raw.map(([, selector]) => selector?.trim()),
    [],
  );
});

test("every type size and leading is read from a token", () => {
  // Sizes were inherited piecemeal and never formed a scale: a literal here is a size nobody chose.
  const literals = lines.filter((line) =>
    /^\s*(font-size|line-height): (?!var\(--lsr-)/.test(line),
  );

  assert.deepEqual(literals, [], `type values that bypass the tokens:\n${literals.join("\n")}`);
});

test("every gap between things is a step of one scale", () => {
  // 23 unrelated spacing values used to live here; every gap must come off one scale.
  const spacing =
    /^\s*(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?: ([^;]+);/;
  const offScale = lines.filter((line) => {
    const value = spacing.exec(line)?.[3];
    if (value === undefined) return false;
    // The code line's left padding is the gutter it clears, not a gap.
    return value
      .split(/\s+/)
      .some((part) => !/^(0|auto|var\(--lsr-(space-\d+|gutter)\))$/.test(part));
  });

  assert.deepEqual(offScale, [], `spacing off the scale:\n${offScale.join("\n")}`);
});

test("the code is sized, led and spaced for reading, not left at diff2html's defaults", () => {
  const table = /\.d2h-diff-table\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  assert.match(table, /font-size: var\(--lsr-size-code\);/, "the diff keeps diff2html's 13px");
  assert.match(table, /line-height: var\(--lsr-leading-code\);/, "code rows have no leading");
  // The repo indents with two spaces; the browser renders a tab as eight.
  assert.match(table, /tab-size: 2;/);
  // `=>` and `!==` are two tokens in the source and must stay two on screen.
  assert.match(table, /font-variant-ligatures: none;/);
});

test("unified spends its width on code, not on padding nothing is drawn in", () => {
  // diff2html defaults: 8em side padding, two number columns with one blank per add/remove row.
  // Kept: one column, left padding exactly the gutter it clears.
  const codeLine = /\.d2h-code-line\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  assert.match(codeLine, /padding: 0 0 0 var\(--lsr-gutter\);/);
  assert.match(css, /\.d2h-code-linenumber\b[^{]*\{[^}]*width: var\(--lsr-gutter\);/);
  // A deletion is the one row whose number lives in the old column.
  assert.match(css, /\.d2h-code-linenumber:not\(\.d2h-del\) \.line-num1[\s\S]*?display: none;/);
  assert.match(css, /\.d2h-code-linenumber\.d2h-del \.line-num2[\s\S]*?display: none;/);
});

// Strip comments so a selector match does not drag the preceding comment along.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Bodies of every rule naming exactly this selector; whitespace collapsed so formatter wraps don't matter. */
function rulesFor(selector: string): string[] {
  const wanted = tidy(selector);
  return [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, list]) => (list ?? "").split(",").some((one) => tidy(one) === wanted))
    .map(([, , body]) => body ?? "");
}

/** One selector the way a hand would write it: runs of space collapsed, none inside a paren. */
function tidy(selector: string): string {
  return selector.trim().replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

test("a token with nothing to break at wraps rather than scrolling the panel sideways", () => {
  // Regression: an unbroken token like `[JsonPolymorphic(TypeDiscriminatorPropertyName` grew the
  // history (a scroll container on both axes) a sideways scrollbar.
  assert.deepEqual(
    rulesFor(".lsr-panel-scroll").filter((body) => /overflow-wrap: anywhere;/.test(body)).length,
    1,
  );
});

test("the popup wraps on its own, inheriting nothing from the panel", () => {
  // Appended to `<body>`, so it inherits nothing from the panel; holds paths and code, the least breakable content.
  assert.deepEqual(
    rulesFor(".lsr-popup").filter((body) => /overflow-wrap: anywhere;/.test(body)).length,
    1,
  );
});

test("a popup too tall for the screen scrolls inside itself, rather than off the bottom", () => {
  // popup-position.ts fits measured height to screen minus 8px; uncapped, the popup measures
  // taller than any screen and the Queue Feedback button lands unreachable.
  const popup = rulesFor(".lsr-popup");

  assert.equal(
    popup.filter((body) => /max-height: calc\(100vh - 8px\);/.test(body)).length,
    1,
    "the cap is written in the placement's own pixels, which no root font size moves",
  );
  assert.equal(popup.filter((body) => /overflow-y: auto;/.test(body)).length, 1);
});

test("the list of files is what the popup scrolls, so the button below it stays put", () => {
  // Whole-popup cap is a backstop; only the file list grows unbounded, so capping it is what
  // keeps the button on screen.
  const files = rulesFor(".lsr-popup-files");

  assert.equal(files.filter((body) => /max-height:/.test(body)).length, 1);
  assert.equal(files.filter((body) => /overflow-y: auto;/.test(body)).length, 1);
});

test("the popup is placed against the page, which is what its position is measured in", () => {
  // popup-position.ts returns page coordinates; position: fixed would read them as screen ones,
  // placing the popup a scroll's worth too far down.
  assert.equal(rulesFor(".lsr-popup").filter((body) => /position: absolute;/.test(body)).length, 1);
});

test("a pasted token wraps in the boxes a reviewer types into", () => {
  // Neither textarea inherits the panel's rule: the compose box is a sibling of
  // the history, the popup's is under a UA `overflow-wrap: break-word`.
  assert.deepEqual(
    rulesFor("textarea").filter((body) => /overflow-wrap: anywhere;/.test(body)).length,
    1,
  );
});

test("quoted code keeps the indentation that says where the line sat", () => {
  // `pre` would refuse every break the wrapping rules above hand it.
  const quoted = rulesFor(".lsr-prompt-selection");
  assert.equal(quoted.length, 1);
  assert.match(quoted[0] ?? "", /white-space: pre-wrap;/);
});

test("the boxes holding a reviewer's words wrap their overflow, never clip it", () => {
  // Both overflow spellings checked: this file uses the shorthand, so an overflow-x-only guard misses it.
  // .lsr-panel itself is absent on purpose: it is the frame, and clips to hold the history to panel height.
  const boxes = [".lsr-panel-scroll", ".lsr-popup", ".lsr-entry", ".lsr-pill", "textarea"];

  const clipped = boxes.filter((box) =>
    rulesFor(box).some((body) => /overflow(-x)?:[^;]*\bhidden\b/.test(body)),
  );

  assert.deepEqual(clipped, []);
});

test("only the panel, the popup and the compose boxes wrap mid-token", () => {
  // overflow-wrap inherits: a stray one further up would rewrap the diff. Split and sorted so
  // reflowing a selector list is not a change, but adding an entry is.
  const wrapping = [...bare.matchAll(/([^{}]+)\{[^}]*overflow-wrap:[^}]*\}/g)]
    .flatMap(([, list]) => (list ?? "").split(","))
    .map((one) => one.trim())
    .sort();

  assert.deepEqual(
    wrapping,
    [".lsr-panel-scroll", ".lsr-popup", "textarea"],
    "a new mid-token wrap is a deliberate choice: say so here, and check it cannot reach the diff",
  );
});

test("the diff is painted from the same tokens as the chrome around it", () => {
  // diff2html's variables must be redefined or the diff keeps its GitHub palette.
  for (const token of ["--d2h-bg-color", "--d2h-ins-bg-color", "--d2h-del-bg-color"]) {
    assert.match(css, new RegExp(`${token}:`), `${token} is left at diff2html's default`);
  }
});

test("the hunk header is quiet, not a band the reviewer has to read past", () => {
  // Regression: --lsr-surface (one step off chrome bg) sat two shades up on the diff's --lsr-bg,
  // lighting the @@ rows pale blue.
  assert.match(css, /--d2h-info-bg-color: var\(--lsr-code-quiet\);/);
});

test("the diff's quiet shade is a step off the code's own background, not off the chrome's", () => {
  // Quiet only reads quiet when built from the same bases as --lsr-bg, in both schemes.
  const token = /--lsr-code-quiet:([^;]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?[^;]*);/.exec(css)?.[1];

  assert.ok(token !== undefined, "the diff's quiet rows have no token of their own");
  assert.match(token, /light-dark\(/, "the quiet shade is painted for one scheme only");
  assert.doesNotMatch(token, /--lsr-(surface|raised)/, "a chrome surface is the wrong backdrop");
});

test("a header segment is a press that still looks like a bar", () => {
  // Segments render as buttons: unreset, the button base's padding and accent fill turn each
  // one solid and double height.
  const segment = rulesFor(".lsr-progress-segment").join("");
  assert.match(segment, /padding: 0;/, "the button base's padding leaks into the bar");
  assert.match(segment, /background: var\(--lsr-border\);/);

  assert.match(rulesFor(".lsr-index-name").join(""), /font-size: var\(--lsr-size-title\);/);
  // A chapter's gate keeps the survey's sizes, so entering it never shrinks its name.
  assert.match(rulesFor(".lsr-gate-name").join(""), /font-size: var\(--lsr-size-title\);/);
  assert.match(rulesFor(".lsr-gate-rationale").join(""), /font-size: var\(--lsr-size-lead\);/);
});

test("the chapter's rationale is set to be read, not to be skipped past", () => {
  // The gate is the whole screen: its sentence is what the reviewer is there
  // to read, so it may not wear the grey the page files metadata under.
  const sentence = rulesFor(".lsr-gate-rationale").join("");

  assert.doesNotMatch(sentence, /var\(--lsr-muted\)/);
  assert.doesNotMatch(
    bare,
    /\.lsr-gate-(rationale|name)[^{]*\{[^}]*color: var\(--lsr-muted\)/,
    "nothing else may mute it either",
  );
  // And the card goes away the moment the diff is up: the room is the diff's.
  assert.match(
    rulesFor('.lsr-group:has(.lsr-gate-press[aria-expanded="true"]) .lsr-gate').join(""),
    /display: none;/,
  );
});

test("a chapter cannot be approved from the card that stands in front of its diff", () => {
  // The gate exists to interrupt the tick that costs nothing. Left on the card, the chapter's
  // own tick sits beside "Read the diff" and is the cheaper of the two presses. Only while
  // unticked, though: a finished chapter shuts back onto its card, and the card must show
  // the mark it earned. And never on a sweep chapter's card, which has nothing to protect:
  // its tick is the press the reviewer came to it for.
  const unapproved =
    '.lsr-group:not([data-tier="sweep"]):has(.lsr-gate-press[aria-expanded="false"]):has(.lsr-tick-all:not(:checked)) .lsr-group-foot';
  assert.match(rulesFor(unapproved).join(""), /display: none;/);
  assert.equal(
    rulesFor('.lsr-group:has(.lsr-gate-press[aria-expanded="false"]) .lsr-group-foot').length,
    0,
    "an approved chapter's card keeps its mark",
  );
  assert.doesNotMatch(
    bare,
    /\.lsr-group:has\(\.lsr-gate-press\[aria-expanded="false"\]\):has\(\s*\.lsr-tick-all:not\(:checked\)\s*\)\s+\.lsr-group-foot/,
    "a sweep chapter's card offers its tick",
  );
});

test("the sweep card's label is set as the survey's lane heading is", () => {
  // Same words, same size, same grey: the reviewer meets the lane's heading again on the one
  // card reachable without the lane, and it reads as a label, not as one of the card's sentences.
  const tier = rulesFor(".lsr-gate-tier").join("");
  assert.match(tier, /font-size: var\(--lsr-size-meta\);/);
  assert.match(tier, /color: var\(--lsr-muted\);/);
  const lane = rulesFor(".lsr-sweep-heading").join("");
  assert.match(lane, /font-size: var\(--lsr-size-meta\);/);
  assert.match(lane, /color: var\(--lsr-muted\);/);
});

test("a shut card is one press, and says so with the cursor alone", () => {
  // The whole card opens the chapter, not only the button on it. The cursor is the only
  // announcement: no hover dressing on a card that is text to read.
  const shut = rulesFor('.lsr-group:has(.lsr-gate-press[aria-expanded="false"])');
  assert.equal(shut.length, 1);
  assert.match(shut[0] ?? "", /cursor: pointer;/);
  assert.doesNotMatch(
    bare,
    /\.lsr-group:has\(\.lsr-gate-press\[aria-expanded="false"\]\):hover/,
    "no hover effect on the card",
  );
});

test("a fully ticked group recedes the way an approved file does, and comes back on hover", () => {
  // No per-group state: the tick drives the mark, so card and boxes cannot disagree.
  // Hover and keyboard focus both restore contrast.
  const dimmed = rulesFor(".lsr-group:has(.lsr-tick-all:checked)");
  assert.equal(dimmed.length, 1);
  assert.match(dimmed[0] ?? "", /opacity: 0\.55;/);

  const restored = rulesFor(".lsr-group:has(.lsr-tick-all:checked):hover");
  assert.equal(restored.length, 1);
  assert.match(restored[0] ?? "", /opacity: 1;/);
  assert.ok(
    bare.includes(".lsr-group:has(.lsr-tick-all:checked):focus-within"),
    "keyboard focus restores it too",
  );
});

test("dimming never stacks: one faded card, not a faded file inside a faded group", () => {
  // Opacity multiplies, so an approved file inside an approved group would come
  // out at 0.55 x 0.55 = 0.30 the moment the reviewer opens one to look again.
  const files = rulesFor(".lsr-group:has(.lsr-tick-all:checked) .lsr-file");
  assert.equal(files.length, 1);
  assert.match(files[0] ?? "", /opacity: 1;/);
});

test("regression guard: the round's line keeps the three properties that pin it", () => {
  // Legibility was judged in a browser; this pins the three declarations that judgement rests on.
  const mark = rulesFor(".lsr-round-mark").join("");
  assert.match(mark, /position: sticky;/);
  assert.match(mark, /top: 0;/);
  assert.match(mark, /background: var\(--lsr-surface\);/);
});

test("an earlier round's messages read as history without being faded out", () => {
  // Old entries keep contrast (reviewer scrolled up to read them); opacity is barred because it
  // multiplies down the tree.
  const earlier = rulesFor('.lsr-entry[data-round-state="earlier"]');
  assert.equal(earlier.length, 1);
  assert.match(earlier[0] ?? "", /background: none;/);
  assert.doesNotMatch(earlier[0] ?? "", /opacity/);
});

// Regression: regions naming only one axis let auto-flow deal them the wrong cells.
// The intent is absent on purpose: it scrolls inside the region, not on the page grid.
const PAGE_REGIONS = [
  { selector: ".lsr-header", column: "1 / -1", row: "1" },
  { selector: ".lsr-review", column: "1", row: "2" },
  { selector: ".lsr-panel-rail", column: "2", row: "2 / -1" },
  { selector: ".lsr-panel", column: "3", row: "2 / -1" },
];

/** All rules placing this selector on a grid: a second placement is itself the bug, so return all rather than pick by cascade. */
function placementsOf(selector: string): { column?: string; row?: string }[] {
  const named = new RegExp(`\\${selector}(?![\\w-])`);
  return [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(
      ([, list, body]) => named.test(list ?? "") && /grid-(area|column|row):/.test(body ?? ""),
    )
    .map(([, , body]) => ({
      column: /grid-column: ([^;]+);/.exec(body ?? "")?.[1],
      row: /grid-row: ([^;]+);/.exec(body ?? "")?.[1],
    }));
}

test("every region of the page names both its column and its row, in one rule", () => {
  const placed = PAGE_REGIONS.map(({ selector }) => {
    const rules = placementsOf(selector);
    assert.equal(rules.length, 1, `${selector} is placed by ${rules.length} rules, not one`);
    return { selector, ...rules[0] };
  });

  assert.deepEqual(placed, PAGE_REGIONS, "a region placed by halves is a region placed by luck");
});

test("guard: the shell renders no region the grid has not been told where to put", () => {
  // Guard: a new shell region without a placement would be dealt the wrong cells again. Matched by
  // template shape (no HTML parser). .lsr-popup absent on purpose: annotation-popup.ts appends it at runtime.
  const body = /<body[^>]*>([\s\S]*?)<\/body>/.exec(shell)?.[1] ?? "";
  const rendered = [...body.matchAll(/^ {4}<\w+[^>]*class="([^"]+)"/gm)]
    .map(([, name]) => `.${name}`)
    .sort();

  assert.ok(rendered.length > 0, "expected the shell's regions to be found");
  assert.deepEqual(rendered, PAGE_REGIONS.map(({ selector }) => selector).sort());
});

test("the header's bar gives its room back before the exact count does", () => {
  // 746px measured in the browser: the row stops fitting there with the bar at its 8rem floor.
  // The count is never shrunk — it says what the bar cannot say exactly.
  const bar = rulesFor(".lsr-progress-bar").join("");
  assert.match(bar, /min-width: 8rem;/);
  assert.match(bar, /flex: 1 1 auto;/);
  // The bar takes the row's slack and gives it back first; fixed at content size it would starve
  // the presence sentence.
  assert.match(rulesFor(".lsr-progress").join(""), /flex: 1 1 12rem;/);
  assert.match(bare, /@media \(max-width: 746px\)\s*\{\s*\.lsr-progress-bar\s*\{\s*display: none;/);
  assert.match(rulesFor(".lsr-progress-count").join(""), /flex: 0 0 auto;/);
  assert.doesNotMatch(rulesFor(".lsr-progress").join(""), /min-width: 0;/);
});

test("a narrow window stacks an index entry instead of ellipsizing its name away", () => {
  // Regression: below 860px the grid's `auto` columns squeezed the name to "Auth …"; as a
  // wrapping flex row the name takes a full line and wraps instead.
  assert.match(
    bare,
    /@media \(max-width: 860px\)\s*\{\s*\.lsr-index-entry\s*\{\s*display: flex;\s*flex-wrap: wrap;/,
  );
  assert.match(
    bare,
    /@media \(max-width: 860px\)[\s\S]*?\.lsr-index-name\s*\{\s*flex: 0 0 100%;\s*white-space: normal;/,
  );
});

test("the count sits on the header's baseline, which a bar has none of", () => {
  // A centred box hands the header row no baseline: the count then floats half a pixel off the
  // branch name beside it.
  assert.match(rulesFor(".lsr-progress").join(""), /align-items: baseline;/);
  assert.match(rulesFor(".lsr-progress-bar").join(""), /align-self: center;/);
});

test("a review of 25 groups is still 25 segments the eye can count", () => {
  // Without the floor a tiny group's segment is a sub-pixel sliver. The floor is a pointer's
  // width, and capped at an equal share of the row so 25 of them cannot push the header wider
  // than the page.
  const segment = rulesFor(".lsr-progress-segment").join("");
  assert.match(segment, /min-width: min\(\s*var\(--lsr-space-8\),/);
  assert.match(segment, /100% \/ var\(--lsr-progress-segments, 1\) - var\(--lsr-space-1\)/);
});

test("the segment is pressable at a pointer's height without being drawn at it", () => {
  // 12px tall is right for a bar and half of the 24px a pointer target owes; the ::after grows
  // the target past the pill on both sides and stays invisible. The clip had to go with it.
  const hit = rulesFor(".lsr-progress-segment::after").join("");

  assert.match(hit, /position: absolute;/);
  assert.match(hit, /inset-block: calc\(-1 \* var\(--lsr-space-2\)\);/);
  assert.match(hit, /inset-inline: 0;/);
  assert.match(rulesFor(".lsr-progress-segment").join(""), /position: relative;/);
  assert.doesNotMatch(rulesFor(".lsr-progress-segment").join(""), /overflow: hidden;/);
});

test("a swept chapter's segment says so in the weave, and only in the weave", () => {
  // The bar answers "how much is left"; the hatch is how the same width also
  // answers "how much of that is reading". Painted in the line colour the empty
  // slot already uses, so the tier costs the bar no second colour.
  const swept = rulesFor('.lsr-progress-segment[data-tier="sweep"]').join("");

  assert.match(swept, /background: repeating-linear-gradient\(/);
  assert.match(swept, /var\(--lsr-border\) 0 var\(--lsr-space-1\)/);
  // Approval fill is untouched: a hatched segment fills like every other one.
  assert.doesNotMatch(swept, /\.lsr-progress-fill/);
});

test("the mechanical lane is a band under the survey, not a card beside it", () => {
  const lane = rulesFor(".lsr-sweep").join("");

  assert.match(lane, /border-top: 1px solid var\(--lsr-border\);/);
  assert.match(lane, /margin-top: var\(--lsr-space-12\);/);
  // Quieter than the chapter names it sits under, which are at title size.
  assert.match(rulesFor(".lsr-sweep-heading").join(""), /color: var\(--lsr-muted\);/);
  assert.match(rulesFor(".lsr-sweep-heading").join(""), /font-size: var\(--lsr-size-meta\);/);
  // The one press keeps the accent fill every button on the page is given.
  assert.doesNotMatch(rulesFor(".lsr-sweep-approve").join(""), /background:/);
});

test("a segment says how far its group got in a colour, not only in a width", () => {
  // At 8px tall, 90% full and finished look the same; the hue tells them apart.
  const partial = rulesFor('.lsr-progress-segment[data-state="partial"] .lsr-progress-fill').join(
    "",
  );
  assert.match(
    partial,
    /background: color-mix\(in srgb, var\(--lsr-accent\) \d+%, var\(--lsr-surface\)\);/,
  );
  const fill = rulesFor(".lsr-progress-fill").join("");
  assert.match(fill, /background: var\(--lsr-accent\);/);
  // Why the bar is patched rather than redrawn: the width animates to its new place.
  assert.match(fill, /transition: width \d+ms/);
});

test("the send buttons are pinned to the panel's own height, not to the conversation's", () => {
  // Regression: invisible send buttons. Without min-height: 0 the history row's automatic minimum
  // floors it at content height and pushes the compose row off the bottom.
  const panel = rulesFor(".lsr-panel").join("");
  assert.match(panel, /grid-template-rows: minmax\(0, 1fr\) auto;/);
  assert.match(panel, /overflow: hidden;/);

  const history = rulesFor(".lsr-panel-scroll").join("");
  assert.match(history, /overflow-y: auto;/);
  assert.match(history, /min-height: 0;/);
});

test("the review scrolls inside its own row rather than growing the page", () => {
  // In the `auto` row the region would size to its content — as tall as every file — and nothing
  // pinned to the page bottom stays on screen.
  const rows = /grid-template-rows: ([^;]+);/.exec(rulesFor("body").join(""))?.[1];
  assert.equal(rows, "auto minmax(0, 1fr)");

  const review = rulesFor(".lsr-review").join("");
  assert.match(review, /grid-row: 2;/);
  assert.match(review, /overflow-y: auto;/);

  // An `overflow` here would make the diff its own scroll container again — the layout that
  // pinned the intent.
  assert.doesNotMatch(rulesFor(".lsr-diff").join(""), /overflow/);
});

test("the intent scrolls away with the diff instead of holding a row open", () => {
  // A height cap here would be a second scroller inside the first, catching the wheel on the way past.
  const intent = rulesFor(".lsr-intent").join("");
  assert.doesNotMatch(intent, /grid-(area|column|row):/);
  assert.doesNotMatch(intent, /max-height:/);
  assert.doesNotMatch(intent, /overflow/);
});

test("guard: shutting the panel gives back the panel's column and keeps the rail's", () => {
  // Regions are placed by line number, so the track count puts the panel at the right edge:
  // `3` stays last, open or shut.
  const open = /grid-template-columns: ([^;]+);/.exec(rulesFor("body").join(""))?.[1];
  const shut = /grid-template-columns: ([^;]+);/.exec(
    rulesFor('[data-panel="collapsed"]').join(""),
  )?.[1];

  assert.equal(open, "minmax(0, 1fr) auto 22rem");
  assert.equal(shut, "minmax(0, 1fr) auto 0");
});

test("last round's feedback is marked in a colour the approval badge cannot be read as", () => {
  // Both badges can share a row: amber = verdict an edit undid, violet = where the reviewer last looked.
  const commented = rulesFor(".lsr-file-commented").join("");
  const approval = rulesFor(".lsr-file-approval").join("");

  assert.match(commented, /var\(--lsr-violet\)/);
  assert.doesNotMatch(commented, /--lsr-amber/);
  assert.match(approval, /var\(--lsr-amber\)/);
  assert.doesNotMatch(approval, /--lsr-violet/);
  // Same pill shape either way, or it reads as a different kind of thing.
  for (const shape of [/border-radius: 999px;/, /white-space: nowrap;/]) {
    assert.match(commented, shape);
    assert.match(approval, shape);
  }
});

test("a row wearing every badge at once wraps rather than covering the diff switch", () => {
  // Badges are nowrap, so nothing shrinks: without the wrap the last badge paints over the switch.
  assert.match(rulesFor(".lsr-file-header").join(""), /flex-wrap: wrap;/);
});

test("the scrim the closing summary is centred on is painted too", () => {
  // The summary's own classes are guarded per area in stylesheet-boundary.test.ts, which reads
  // them off its render; this scrim is rendered by the banner around it, so that guard never
  // sees it and it would go unpainted unnoticed.
  assert.ok(rulesFor(".lsr-ended-overlay").length > 0);
});

test("the control that reopens the replay is painted too", () => {
  // The overlay's own classes are guarded per area in stylesheet-boundary.test.ts, which reads
  // them off renderReplayOverlay; this button sits in the shell's header, so that guard never
  // sees it and it would go unpainted unnoticed.
  assert.ok(rulesFor(".lsr-replay-reopen").length > 0);
});

test("only the sheet being spoken is on screen: the rest are below it or gone above it", () => {
  // Coming sheets rise from below, done ones lift away above, both invisible in transit:
  // a second readable sheet is a second thing to read.
  const under = rulesFor('.lsr-opening-sheet[data-at="under"]').join("");
  const gone = rulesFor('.lsr-opening-sheet[data-at="gone"]').join("");

  assert.match(under, /transform: translateY\(3\.5rem\)/, "the sheets to come sit below");
  assert.match(gone, /transform: translateY\(-3\.5rem\)/, "and the peeled ones lift away");
  for (const body of [under, gone]) {
    assert.match(body, /opacity: 0;/);
    assert.match(body, /pointer-events: none;/);
  }
  assert.match(rulesFor('.lsr-opening-sheet[data-at="top"]').join(""), /opacity: 1;/);
});

test("the room grows with the longest reason instead of scrolling it", () => {
  // Sheets share one grid cell so the tallest sizes the room; a fixed height is the old scroll
  // trap, and `safe` centering keeps a scrolled sheet's top reachable.
  const stack = rulesFor(".lsr-opening-stack").join("");
  const sheet = rulesFor(".lsr-opening-sheet").join("");

  assert.match(stack, /min-height:/, "short reasons keep the room from collapsing");
  assert.doesNotMatch(stack, /(?<!(min|max)-)height:/, "a fixed height is the old scroll trap");
  assert.match(sheet, /grid-area: 1 \/ 1;/, "every sheet lies in the same cell");
  assert.match(sheet, /align-content: safe center;/, "a scrolled sheet must keep its top");
});

test("the opening is painted for both schemes at once, never for one of them", () => {
  // A hand-picked scheme overrides the machine's: prefers-color-scheme would follow the machine
  // while the page follows the pick, so every local uses light-dark().
  const room = rulesFor(".lsr-opening-overlay").join("");

  for (const local of [
    "room",
    "lamp",
    "halo",
    "edge",
    "pool",
    "dust",
    "flash",
    "bloom-core",
    "bloom-edge",
  ]) {
    assert.match(
      room,
      new RegExp(`--lsr-opening-${local}:\\s*light-dark\\(`),
      `--lsr-opening-${local} is painted for one scheme only`,
    );
  }
  assert.doesNotMatch(bare, /prefers-color-scheme/);
  // A filter cannot be scheme-switched the way a colour can, so the flare is opacity only.
  assert.doesNotMatch(
    rulesFor('.lsr-opening-overlay[data-flare="true"]::after').join(""),
    /filter/,
  );
});

test("a reviewer who asked for less motion gets the handover without the movement", () => {
  // The one feature that moves something across a whole screen.
  assert.match(
    bare,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.lsr-opening-sheet\s*\{\s*transition: none;/,
  );
  const quiet = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/.exec(bare)?.[1] ?? "";

  // Lights go out rather than fade: a quarter-second of white is worse than no reward.
  assert.match(quiet, /\.lsr-opening-motes,\s*\.lsr-opening-bloom \{\s*display: none;/);
  assert.match(quiet, /\.lsr-opening-overlay\[data-flare="true"\]::after \{\s*opacity: 0;/);
  assert.match(
    quiet,
    /\.lsr-opening-sheet\[data-at="top"\] \.lsr-opening-body \{\s*animation: none;/,
  );
  assert.match(quiet, /\.lsr-opening-press \{\s*animation: none;/);
});

test("the busy marker holds still for that reviewer rather than going away", () => {
  const quiet = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/.exec(bare)?.[1] ?? "";

  // Hiding the marker would answer the preference by taking the news away: the dots stop
  // animating but stay up.
  assert.match(quiet, /\.lsr-working-dots i \{\s*animation: none;/);
  assert.doesNotMatch(quiet, /\.lsr-working[\w-]* \{[^}]*display: none/);
});

test("the round's announcement holds still too: no fold flight, no orbiting spark", () => {
  const quiet = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/.exec(bare)?.[1] ?? "";

  // Animations may go; the news itself must survive.
  assert.match(quiet, /\.lsr-round-card \{\s*animation: none;/);
  assert.match(quiet, /#lsr-round-popup\[data-state="folding"\] \{\s*display: none;/);
  assert.match(quiet, /\.lsr-round-offer\[data-beckon="true"\] \{\s*animation: none;/);
  assert.match(quiet, /\.lsr-round-offer\[data-beckon="true"\]::after \{\s*display: none;/);
});
