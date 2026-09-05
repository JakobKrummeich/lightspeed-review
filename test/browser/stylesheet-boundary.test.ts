import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  FORM_PENDING,
  FORM_UNAVAILABLE,
  renderFetchedForm,
} from "../../src/browser/approved-form.ts";
import { renderClosingSummary, type ClosedReview } from "../../src/browser/closing-summary.ts";
import { renderOpening } from "../../src/browser/opening-view.ts";
import { renderReplayOverlay } from "../../src/browser/round-replay.ts";
import type { ApprovedFormData } from "../../src/rounds/approved-form.ts";
import type { ReplayComment } from "../../src/rounds/replay.ts";

const ENTRY = new URL("../../src/browser/chrome.css", import.meta.url);
const CSS_DIR = new URL("../../src/browser/css/", import.meta.url);
const CEILING = 300; // the same ceiling eslint.config.js puts on src/**/*.ts

/**
 * Areas allowed past the ceiling, with the size they may not exceed. A budget
 * only ever goes down, and an entry is deleted when its file no longer needs
 * one: `base.css`, the un-split remainder of chrome.css, was carried here from
 * 1,744 content lines to nothing across twelve steps and is gone. New rules go
 * in the area they belong to, never into a file with a budget.
 *
 * The number is content lines, the unit this file measures and the unit
 * eslint's `max-lines` counts.
 *
 * `index.css` is the one area that lands past the ceiling, and it is past it by
 * breadth rather than by depth: the chapter index, the focus bar, the file cards
 * and their tick boxes are one screen of
 * the review, read top to bottom, and several of their rules are about the seam
 * between two of those things — `.lsr-group:has(.lsr-tick-all:checked)
 * .lsr-file` is one. The cascade
 * puts the whole run between the panel and the popup, so splitting it would draw
 * an arbitrary line through one screen rather than a boundary. It stays whole,
 * and it stays listed here so the next area past the ceiling has to argue its
 * case in this comment.
 */
const REMAINDER_BUDGET: Record<string, number> = { "index.css": 328 };

/** The area stylesheets the entry imports, in cascade order. */
function importedNames(): string[] {
  const entry = readFileSync(ENTRY, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...entry.matchAll(/^@import "\.\/css\/([\w.-]+\.css)";$/gm)].map(([, n]) => n ?? "");
}

/** Lines that are a rule: neither blank nor comment. */
function contentLines(css: string): number {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
}

test("the entry is an ordered import list and nothing else", () => {
  const body = readFileSync(ENTRY, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const stray = body.split("\n").filter((l) => l.trim() !== "" && !/^@import "\.\/css\//.test(l));

  assert.deepEqual(stray, [], `a rule in the entry is a rule with no area:\n${stray.join("\n")}`);
});

test("every area stylesheet is imported exactly once", () => {
  // Silent incompleteness: a file nothing imports is styling that vanishes with
  // no error anywhere — the page just renders wrong.
  const imported = importedNames();

  assert.deepEqual([...imported].sort(), [...new Set(imported)].sort(), "imported twice");
  assert.deepEqual([...imported].sort(), readdirSync(CSS_DIR).sort());
});

test("no area stylesheet is past the ceiling eslint holds every module to", () => {
  const over = importedNames().flatMap((name) => {
    const lines = contentLines(readFileSync(new URL(name, CSS_DIR), "utf8"));
    const budget = REMAINDER_BUDGET[name] ?? CEILING;
    return lines > budget ? [`${name}: ${lines} > ${budget}`] : [];
  });

  assert.deepEqual(over, [], `split an area out, or argue the case here:\n${over.join("\n")}`);
});

/** One render module, the area that paints what it draws, and the markup to read its classes off. */
interface AreaOwner {
  /** The module emitting the classes, by the path a grep for one of them lands in. */
  module: string;
  /** The area stylesheet under `css/` that has to paint every one of them. */
  area: string;
  /** That module rendered with one of everything it draws. */
  render: () => string;
  /** A class the render must contain, so a fixture that draws nothing cannot pass. */
  marker: string;
}

/** A closed review holding one of everything the summary counts. */
const CLOSED_REVIEW: ClosedReview = {
  groups: [
    {
      name: "Schema",
      rationale: "why",
      files: [
        {
          path: "src/db.ts",
          status: "modified",
          diff: "@@ -1 +1 @@\n-old\n+new",
          insertions: 3,
          deletions: 1,
          oversized: false,
        },
      ],
    },
  ],
  conversation: [
    {
      role: "reviewer",
      at: "2025-01-01T00:00:00.000Z",
      prompts: [{ type: "message", comment: "hm" }],
    },
  ],
  rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z" }],
  approved: ["src/db.ts"],
  endedBy: "reviewer",
};

/** One replay card wearing every part a card can draw: quote, note, and an answer file of each kind. */
const REPLAY_CARD: ReplayComment = {
  id: "c1",
  file: "src/db.ts",
  group: "Schema",
  anchor: null,
  selected_text: "+const x = 1;",
  comment: "rename this",
  status: "addressed",
  declared: true,
  state: "ok",
  answers: [
    {
      file: "src/db.ts",
      hunks: [{ header: "@@ -1 +1 @@", body: "-a\n+b", insertions: 1, deletions: 1 }],
    },
    { file: "src/other.ts", hunks: [] },
    { file: "src/big.ts", hunks: [], oversized: true },
  ],
  note: "done",
};

/**
 * The overlay in the three shapes that draw different elements: a declared card
 * with hunks and dots, an undeclared one falling back to the round reply, and a
 * card whose commits a rebase took away. One shape leaves the others unguarded.
 */
function replayOverlay(): string {
  const renderer = { renderFile: (diff: string) => `<pre>${diff}</pre>` };
  return [
    renderReplayOverlay({ data: { comments: [REPLAY_CARD, REPLAY_CARD] }, current: 0 }, renderer),
    renderReplayOverlay(
      {
        data: { comments: [{ ...REPLAY_CARD, declared: false, note: undefined, answers: [] }] },
        roundReply: "the round reply",
        current: 0,
      },
      renderer,
    ),
    renderReplayOverlay(
      {
        data: { comments: [{ ...REPLAY_CARD, state: "unreachable", status: "unknown" }] },
        current: 0,
      },
      renderer,
    ),
  ].join("");
}

/** One fetched form, in the state that draws a diff; the others differ only in `state`. */
const FETCHED_FORM: ApprovedFormData = {
  path: "src/db.ts",
  paths: ["src/db.ts"],
  from: "1111111aaaaaaa",
  to: "2222222bbbbbbb",
  state: "diff",
  diff: "@@ -1 +1 @@\n-old\n+new",
};

/**
 * Every band the fetched forms draw: the diff with the note above it, the
 * sentence a state with no diff gets instead, and the two the store swaps in
 * while git answers or after it fails. The last two are exported markup rather
 * than a render, and `lsr-approved-pending` is drawn nowhere else — leaving
 * them out would leave that class unguarded.
 */
function approvedForms(): string {
  const renderer = { renderFile: (diff: string) => `<pre>${diff}</pre>` };
  return [
    renderFetchedForm("approved", { data: FETCHED_FORM, renderer }),
    renderFetchedForm("last-round", { data: { ...FETCHED_FORM, state: "oversize" }, renderer }),
    ...Object.values(FORM_PENDING),
    ...Object.values(FORM_UNAVAILABLE),
  ].join("");
}

/**
 * Who paints what, module by module: the half of the boundary the import list
 * cannot state. A rule that drifts into another area still reaches the browser
 * — it is served one stylesheet either way — so nothing on screen and no other
 * test says an area has started painting a second module's screen. That is how
 * the 2,916-line file these areas came out of was written, one rule at a time.
 *
 * One module lands per run: the emitters not listed here are the ones still
 * guarded by nothing, and adding one is an entry plus a fixture — where every
 * class the module draws is painted in one area. Measured 2026-09-01, three of
 * the remaining eleven still are: progress-bar.ts and intent-view.ts
 * (page.css), annotation.ts (popup.css). The rest are a different edit, not
 * this one: diff-view.ts, html-template.ts, conversation-panel.ts,
 * round-offer.ts, status-banner.ts and full-file.ts each draw across two or
 * more areas by design (the `.lsr-switch*` pair sits in code.css and is shared
 * by two modules), and several emit a class no area paints at all
 * (`.lsr-index-item`, `.lsr-focus-prev`, `.lsr-form-option`). Both want a
 * decision about where an area's edge runs that this table has no shape for.
 */
const AREA_OWNERS: AreaOwner[] = [
  {
    module: "src/browser/closing-summary.ts",
    area: "closing.css",
    render: () => renderClosingSummary(CLOSED_REVIEW),
    marker: "lsr-closing-figure",
  },
  {
    module: "src/browser/round-replay.ts",
    area: "replay.css",
    render: replayOverlay,
    marker: "lsr-replay-card",
  },
  {
    module: "src/browser/opening-view.ts",
    area: "opening.css",
    // Two reasons is the smallest stack drawing every sheet the opening has: the
    // cover, a reason with a way on, and the last one that opens the review.
    render: () => renderOpening(["sign the tokens", "drop the legacy /login handler"]),
    marker: "lsr-opening-sheet",
  },
  {
    module: "src/browser/approved-form.ts",
    area: "index.css",
    // The fetched forms are drawn inside the file card and painted with it, so
    // their rules belong to the area that paints the card, not to one of their
    // own. `full-file.ts` deliberately reuses these classes; guarding the
    // module that defines them covers both.
    render: approvedForms,
    marker: "lsr-approved-form",
  },
];

/** Every distinct class in a render, however many elements wear it. */
function classesIn(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/class="([^"]+)"/g)].flatMap(([, list]) => (list ?? "").split(" ")),
    ),
  ];
}

/** One area's rules, comments stripped so a class named in prose does not count as painted. */
function areaRules(area: string): string {
  return readFileSync(new URL(area, CSS_DIR), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Whether these rules name this class at all — on its own, inside a compound
 * selector, or under a media query. Naming it is the whole question: an element
 * no rule mentions is an element nobody painted, and it is found on screen or
 * not at all. Which rule paints it is the stylesheet's business, not the test's.
 */
function paints(rules: string, cls: string): boolean {
  return new RegExp(`\\.${cls}(?![\\w-])`).test(rules);
}

test("every class a render module emits is painted in that module's own area", () => {
  for (const { module, area, render, marker } of AREA_OWNERS) {
    const rules = areaRules(area);
    const classes = classesIn(render());

    assert.ok(classes.includes(marker), `${module}: the fixture rendered no ${marker}`);
    assert.deepEqual(
      classes.filter((name) => !paints(rules, name)),
      [],
      `${module} renders classes ${area} does not paint: move the rule into ${area}, or the markup into the module ${area} belongs to`,
    );
  }
});
