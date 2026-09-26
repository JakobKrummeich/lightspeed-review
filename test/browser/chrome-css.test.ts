import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stylesheet } from "../helpers/stylesheet.ts";

// The whole stylesheet: these assertions are about what the browser is served,
// not about where a rule is written.
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
  // A literal here is a size nobody chose.
  const literals = lines.filter((line) =>
    /^\s*(font-size|line-height): (?!var\(--lsr-)/.test(line),
  );

  assert.deepEqual(literals, [], `type values that bypass the tokens:\n${literals.join("\n")}`);
});

test("every gap between things is a step of one scale", () => {
  const spacing =
    /^\s*(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?: ([^;]+);/;
  // A step with a border's width taken back off it is still that step: the words land where
  // they do on a card without the border.
  const stepLessBorder = /^calc\(var\(--lsr-space-\d+\) - \d+px\)$/;
  const offScale = lines.filter((line) => {
    const value = spacing.exec(line)?.[3];
    if (value === undefined || stepLessBorder.test(value)) return false;
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
  const codeLine = /\.d2h-code-line\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";

  assert.match(codeLine, /padding: 0 0 0 var\(--lsr-gutter\);/);
  assert.match(css, /\.d2h-code-linenumber\b[^{]*\{[^}]*width: var\(--lsr-gutter\);/);
  // A deletion is the one row whose number lives in the old column.
  assert.match(css, /\.d2h-code-linenumber:not\(\.d2h-del\) \.line-num1[\s\S]*?display: none;/);
  assert.match(css, /\.d2h-code-linenumber\.d2h-del \.line-num2[\s\S]*?display: none;/);
});

// Strip comments so a selector match does not drag the preceding comment along.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Whitespace collapsed so formatter wraps don't matter. */
function rulesFor(selector: string): string[] {
  const wanted = tidy(selector);
  return [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, list]) => (list ?? "").split(",").some((one) => tidy(one) === wanted))
    .map(([, , body]) => body ?? "");
}

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
  const boxes = [".lsr-panel-scroll", ".lsr-popup", ".lsr-thread", ".lsr-pill", "textarea"];

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

  // `.lsr-gate-path`: one path on the chapter's card, a leaf with no diff under it.
  // `.lsr-file-path`: the path on a file's header row — two paths and an arrow
  // for a moved file — a span in the header button, a sibling of the diff, never over it.
  assert.deepEqual(
    wrapping,
    [".lsr-file-path", ".lsr-gate-path", ".lsr-panel-scroll", ".lsr-popup", "textarea"],
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
  // Not muting it is not enough: set in body weight and body ink, the one
  // sentence the reviewer must read before pressing through was the one skimmed.
  // Its ink is its own (figures below), never the body's.
  assert.doesNotMatch(sentence, /color: var\(--lsr-text\);/);
  // Heavier than body text, lighter than the name: in the name's weight, name
  // and sentence read as one heading.
  const name = rulesFor(".lsr-gate-name").join("");
  const weight = (body: string) => Number(/font-weight: (\d+);/.exec(body)?.[1]);
  assert.ok(weight(sentence) > 400, "the sentence is set in body weight");
  assert.ok(weight(sentence) < weight(name), "the sentence reads as part of the heading");
  // And the card goes away the moment the diff is up: the room is the diff's.
  assert.match(
    rulesFor('.lsr-group:has(.lsr-gate-press[aria-expanded="true"]) .lsr-gate').join(""),
    /display: none;/,
  );
});

test("the chapter's rationale is marked by its ink alone: no stripe, no label, no box", () => {
  // A bar down its edge, an "In short" eyebrow over it and a tinted box round it
  // all read as stock callout dressing: the sentence is set apart by colour.
  const sentence = rulesFor(".lsr-gate-rationale").join("");
  assert.doesNotMatch(sentence, /border|box-shadow|background|padding|border-radius/);
  assert.equal(rulesFor(".lsr-gate-rationale::before").length, 0, "the sentence wears a label");
  assert.doesNotMatch(css, /In short|--lsr-rationale-/);

  // With no box to inset it, the sentence starts where the name does and where
  // the files summary below does: its arrow sits at the line's own left edge.
  assert.match(rulesFor(".lsr-gate-files-summary::before").join(""), /left: 0;/);
});

test("the rationale's ink is its own, clears AA on the card and never passes for a press", () => {
  // `--lsr-lead-ink` keeps the accent's hue at another lightness. Paper: oklch
  // 0.40/0.11, under the accent's 0.55/0.17 that the counter and the press wear,
  // over the body's 0.32 and the name's 0.21 at chroma ~0.01. Night: 0.84/0.09,
  // over the accent's 0.72/0.12, beside the body's 0.87 and under the name's
  // 0.945, both at chroma ~0.01. A mix of accent and strong ink cannot reach it
  // at night: at a share light enough to clear the accent (45%, L 0.84) its
  // chroma is 0.057 and it reads as the body's grey.
  //
  // Measured at 19px weight 500, which is not large text, so 4.5:1 is the bar:
  // 8.92:1 on the card on paper, 9.65:1 at night.
  const tokens = rulesFor(":root").join("");
  assert.match(
    tokens,
    /--lsr-lead-ink: light-dark\(oklch\(0\.4 0\.11 262\), oklch\(0\.84 0\.09 262\)\);/,
    "re-measure the ink",
  );
  const sentence = rulesFor(".lsr-gate-rationale").join("");
  assert.match(sentence, /color: var\(--lsr-lead-ink\);/);
  assert.match(
    sentence,
    /font-weight: 500;/,
    "600 is the name's weight: the two read as one heading",
  );
  assert.doesNotMatch(sentence, /text-decoration/, "an underline would make the sentence a link");
  for (const other of [".lsr-gate-name", ".lsr-gate-counter", ".lsr-gate-press"]) {
    assert.equal(
      rulesFor(other).some((body) => /--lsr-lead-ink/.test(body)),
      false,
      `${other} shares the sentence's ink`,
    );
  }

  // An approved card recedes to .55, where the tinted ink fell to 2.35:1 on
  // paper and 2.70:1 at night. There it takes the strong ink back: 3.95:1 and
  // 5.09:1 on the receded card, what it held before it was tinted, level with
  // the name above it. Hover restores the card, not the tint.
  assert.match(
    rulesFor(".lsr-group:has(.lsr-tick-all:checked) .lsr-gate-rationale").join(""),
    /color: var\(--lsr-strong\);/,
  );
  // Forced colours take the ink: the sentence is left plain text under its
  // heading, and nothing needs to be put back.
  assert.doesNotMatch(bare, /@media \(forced-colors: active\)\s*\{\s*\.lsr-gate-rationale/);
});

test("every chapter's card offers the chapter's tick", () => {
  // Regression: the last chapter of a review was the one place with no tick to
  // press, its card hiding the foot until the diff was up.
  assert.doesNotMatch(
    bare,
    /aria-expanded="false"[^{]*\.lsr-group-foot\s*\{/,
    "the foot is not hidden behind a shut gate",
  );
  assert.equal(rulesFor(".lsr-group-foot").filter((body) => /display: none/.test(body)).length, 0);
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

test("the card's folded file list is a quiet line with the page's arrow on it", () => {
  // One line saying how much the chapter is, set as the tier label is: a label
  // on the chapter, not one of the sentences the card exists to have read.
  const line = rulesFor(".lsr-gate-files-summary").join("");
  assert.match(line, /font-size: var\(--lsr-size-meta\);/);
  assert.match(line, /color: var\(--lsr-muted\);/);
  assert.match(line, /cursor: pointer;/);
  assert.match(line, /list-style: none;/);
  assert.match(
    rulesFor(".lsr-gate-files-summary::before").join(""),
    /transform: rotate\(-45deg\);/,
  );
  assert.match(
    rulesFor(".lsr-gate-files[open] > .lsr-gate-files-summary::before").join(""),
    /transform: rotate\(45deg\);/,
  );
  assert.match(rulesFor(".lsr-gate-files-summary:focus-visible").join(""), /outline: 2px solid/);
});

test("the chapter's card stands in the middle of the screen, its lines flush left", () => {
  // The block is centred, not the words on it: a column of sentences reads
  // from one left edge, and a card hugging the screen's edge read as one more
  // paragraph of the page rather than the page a chapter starts on.
  const card = rulesFor(".lsr-gate").join("");
  assert.match(card, /margin: 0 auto;/);
  assert.match(card, /align-items: start;/);
  assert.doesNotMatch(card, /text-align: center;/);
  // A card is a card by being narrower than the page it lies on, lifted off it,
  // its words near its edges rather than marooned in a full-width band.
  const shut = rulesFor('.lsr-group:has(.lsr-gate-press[aria-expanded="false"])').join("");
  assert.match(shut, /max-width: \d+ch;/);
  assert.match(shut, /margin-inline: auto;/);
  assert.match(shut, /box-shadow: var\(--lsr-shadow-lift\);/);
  // The measure belongs to the card, so the gate does not cap it a second time.
  assert.doesNotMatch(card, /max-width:/);
  assert.doesNotMatch(rulesFor(".lsr-gate-file").join(""), /justify-content: center;/);
  assert.match(rulesFor(".lsr-gate-path").join(""), /overflow-wrap: anywhere;/);
});

test("the bar carries the chapter's name only while the diff is up", () => {
  // On the card the name is in the title size right below the bar; once the
  // card is gone behind the diff, the bar is the only place left to say which
  // chapter this is. Nowhere is it on screen twice.
  assert.match(rulesFor(".lsr-focus-name").join(""), /display: none;/);
  const up = rulesFor(
    '.lsr-focus-bar:has(+ .lsr-group .lsr-gate-press[aria-expanded="true"]) .lsr-focus-name',
  ).join("");
  assert.match(up, /display: block;/);
  // With the name away, the way out pushes the place and the neighbours right by itself.
  assert.match(rulesFor(".lsr-focus-exit").join(""), /margin-right: auto;/);
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

test("each voice of the sidechat is one hue, worn on its label, with no stripe down the card", () => {
  // The agent keeps the accent it has everywhere else on the page; the reviewer the violet of
  // the replay. The bubble is the glance and the label the word, for whoever cannot tell the
  // hues apart; a coloured bar down every card said nothing new and read as stock furniture.
  assert.match(
    rulesFor('.lsr-message[data-role="agent"]').join(""),
    /--lsr-speaker: var\(--lsr-accent\);/,
  );
  assert.match(
    rulesFor('.lsr-message[data-role="reviewer"]').join(""),
    /--lsr-speaker: var\(--lsr-violet\);/,
  );

  // No bar down the bubble's edge: the bubble and the label already tell the voices apart.
  const card = rulesFor(".lsr-message[data-role]").join("");
  assert.doesNotMatch(card, /border-left|padding-left/);

  // Two fifths hue: the night reviewer's card is the ceiling, where the violet is 4.67:1 at
  // two fifths and 4.52:1 at half (paper 6.10:1); the accent on the agent's card is 6.14:1.
  assert.match(
    rulesFor(".lsr-message[data-role] .lsr-message-role").join(""),
    /color: color-mix\(in oklab, var\(--lsr-speaker\) 40%, var\(--lsr-text\)\);/,
  );
});

test("nothing in the sidechat or the replay wears a stripe down its left edge", () => {
  // Cards, pills, the agent's question and answer, and the replay's quote of the reviewer alike:
  // each is told apart by its bubble and its label, never by a bar — drawn as a border, an inset
  // shadow, a painted layer or a thin absolutely placed pseudo-element.
  const length = String.raw`[\d.]+(?:px|r?em)`;
  const bar = new RegExp(
    [
      "border-left",
      "border-inline-start",
      `border-width: 0 0 0 ${length}`,
      `inset ${length} 0`,
      `left / ${length}`,
    ].join("|"),
  );
  const thin = new RegExp(`(?:^|[\\s;])width: (?:[1-6]px|0?\\.[0-3]\\d*r?em);`);
  const striped = [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, list = ""]) => /\.lsr-(thread|message|prompt|pill|replay)/.test(list))
    .filter(([, list = "", body = ""]) => {
      const pseudo = /::(before|after)/.test(list) && /position: absolute;/.test(body);
      return bar.test(body) || (pseudo && thin.test(body));
    })
    .map(([, list]) => list?.trim());
  assert.deepEqual(striped, []);
});

test("the replay quotes the reviewer in a violet bubble under a violet label", () => {
  // With the stripe gone, tint and label are the quote's voice. 16% violet, not the 10% it had
  // beside a stripe, at which the night bubble was a grey box. The label in the violet itself
  // clears AA on it: 5.15:1 on paper, 5.62:1 at night — where the muted grey of the other
  // replay labels is 3.80:1 and 3.54:1.
  const quote = rulesFor(".lsr-replay-quote").join("");
  assert.match(quote, /background: color-mix\(in oklab, var\(--lsr-violet\) 16%, transparent\);/);
  assert.match(quote, /border-radius: 0\.5rem;/, "the bubble is rounded on every side");
  // Exactly one rule colours the label, whatever else its selector says, so the violet applies
  // by being the only colour on offer rather than by winning on source order or specificity.
  const colours = [...bare.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, list]) =>
      (list ?? "").split(",").some((one) => /\.lsr-replay-quote-label(?![\w-])(?!.*::)/.test(one)),
    )
    .flatMap(([, , body]) => [...(body ?? "").matchAll(/(?:^|[\s;])color: ([^;]+);/g)])
    .map(([, value]) => value);
  assert.deepEqual(colours, ["var(--lsr-violet)"], "the label's colour is contested or muted");
});

test("the reviewer's bubble is violet and the agent's is grey, on every round", () => {
  // Neutral against violet, not cobalt against violet: at 14% each, a cobalt card and a violet
  // card differ by 0.021 of oklab lightness on paper and 0.018 at night, one hue step apart for
  // whoever cannot tell the two blues apart; the grey card sits 0.080 and 0.083 away. 30% is
  // 0.154 of lightness off the card's base on paper and 0.146 at night, and where the night
  // labels stop it: at 32% the widest violet label that clears AA is 4.51:1, at 30% 4.67:1.
  // 11% of ink is 0.074 and 0.064 off the base, and 0.063 and 0.104 off the panel.
  const reviewer = rulesFor('.lsr-message[data-role="reviewer"]').join("");
  assert.match(
    reviewer,
    /--lsr-bubble: color-mix\(in oklab, var\(--lsr-violet\) 30%, var\(--lsr-raised\)\);/,
  );

  const agent = rulesFor('.lsr-message[data-role="agent"]').join("");
  assert.match(
    agent,
    /--lsr-bubble: color-mix\(in oklab, var\(--lsr-text\) 11%, var\(--lsr-raised\)\);/,
  );
  assert.doesNotMatch(
    agent,
    /--lsr-bubble:[^;]*var\(--lsr-(accent|violet|green|red|amber|pink|cyan)\)/,
    "the agent's bubble carries no hue",
  );

  // The bubble is the card's background whatever the round's state: a chat keeps its bubbles.
  assert.match(rulesFor(".lsr-message[data-role]").join(""), /background: var\(--lsr-bubble\);/);
  assert.equal(
    rulesFor('.lsr-message[data-role][data-round-state="current"]').length,
    0,
    "the bubble is not a live-round effect",
  );
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
  // Matched by template shape (no HTML parser). .lsr-popup absent on purpose:
  // annotation-popup.ts appends it at runtime.
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
  // the presence label.
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

test("what the change is for is set to be read, not filed as a chrome label", () => {
  // A heading over the sentences the review exists for, set like one — not in
  // the label-size, uppercase, muted treatment this page gives metadata.
  const heading = [".lsr-intent-title", ".lsr-intent-press"].map((one) => rulesFor(one).join(""));

  for (const rules of heading) {
    assert.match(rules, /font-size: var\(--lsr-size-lead\);/);
    assert.match(rules, /line-height: var\(--lsr-leading-tight\);/);
    assert.match(rules, /font-weight: 600;/);
    assert.match(rules, /color: var\(--lsr-strong\);/);
    assert.doesNotMatch(rules, /text-transform:/);
    assert.doesNotMatch(rules, /letter-spacing:/);
  }

  // The reasons themselves are read, so they take paragraph leading rather than
  // the heading's; hierarchy is left to weight and colour, not to size.
  for (const part of [".lsr-intent-list", ".lsr-intent-item", ".lsr-intent-none"]) {
    const rules = rulesFor(part).join("");
    assert.match(rules, /font-size: var\(--lsr-size-lead\);/, `${part} is left at body size`);
    assert.match(rules, /line-height: var\(--lsr-leading\);/, `${part} is led as a heading`);
  }

  // A hint about a press, not part of the heading it sits in.
  const hint = rulesFor(".lsr-intent-hint").join("");
  assert.match(hint, /font-size: var\(--lsr-size-meta\);/);
  assert.match(hint, /color: var\(--lsr-muted\);/);
  assert.match(hint, /font-weight: 400;/);
});

test("the intent's press is a heading with an arrow, not a button on the page", () => {
  // The button base fills every press with the accent and pads it; unreset, the
  // review would open on a solid blue slab where its first heading belongs.
  const press = rulesFor(".lsr-intent-press").join("");
  assert.match(press, /background: transparent;/);
  assert.match(press, /cursor: pointer;/);
  assert.match(press, /width: 100%;/, "the whole row is the press, not the words alone");
  assert.match(press, /text-align: left;/);

  // The same arrow the file rows use, turned by the same attribute: one glyph
  // system for every disclosure on the page.
  const arrow = rulesFor(".lsr-intent-press::before").join("");
  assert.match(arrow, /border-right: 2px solid var\(--lsr-muted\);/);
  assert.match(arrow, /transform: rotate\(-45deg\);/);
  assert.match(
    rulesFor('.lsr-intent-press[aria-expanded="true"]::before').join(""),
    /transform: rotate\(45deg\);/,
  );
  // Open, the turned arrow is the whole affordance — as it is on a file row.
  assert.match(
    rulesFor('.lsr-intent-press[aria-expanded="true"] .lsr-intent-hint').join(""),
    /display: none;/,
  );
  assert.match(
    rulesFor(".lsr-intent-press:focus-visible").join(""),
    /outline: 2px solid var\(--lsr-accent\);/,
  );
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
  // stylesheet-boundary.test.ts guards the summary's classes off its render; this
  // scrim is rendered by the banner around it, so that guard never sees it.
  assert.ok(rulesFor(".lsr-ended-overlay").length > 0);
});

test("the control that reopens the replay is painted too", () => {
  // stylesheet-boundary.test.ts guards the overlay's classes off renderReplayOverlay;
  // this button sits in the shell's header, so that guard never sees it.
  assert.ok(rulesFor(".lsr-replay-reopen").length > 0);
});

test("only the sheet being spoken is on screen: the rest are below it or gone above it", () => {
  // Both invisible in transit: a second readable sheet is a second thing to read.
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

test("the finish stands where the round's announcement does, and under the ended overlay", () => {
  // Same layer as its sibling: news with a press on it. The ended overlay's word is last, and
  // pressing the card's end is what puts it up — so the card must sit below it.
  const done = rulesFor(".lsr-done-overlay").join("");
  const round = rulesFor(".lsr-round-overlay").join("");
  const layer = (body: string): string => /z-index: (\d+);/.exec(body)?.[1] ?? "";
  assert.equal(layer(done), layer(round));
  assert.ok(Number(layer(done)) < Number(layer(rulesFor(".lsr-ended-overlay").join(""))));
  assert.match(done, /background: var\(--lsr-scrim\);/);
});

test("the finish holds still for the reviewer who asked for less movement", () => {
  const quiet = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/.exec(bare)?.[1] ?? "";

  assert.match(quiet, /\.lsr-done-card,\s*\.lsr-done-mark \{\s*animation: none;/);
});

test("the round's announcement holds still too: no fold flight, no orbiting spark", () => {
  const quiet = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/.exec(bare)?.[1] ?? "";

  // Animations may go; the news itself must survive.
  assert.match(quiet, /\.lsr-round-card \{\s*animation: none;/);
  assert.match(quiet, /#lsr-round-popup\[data-state="folding"\] \{\s*display: none;/);
  assert.match(quiet, /\.lsr-round-offer\[data-beckon="true"\] \{\s*animation: none;/);
  assert.match(quiet, /\.lsr-round-offer\[data-beckon="true"\]::after \{\s*display: none;/);
});
