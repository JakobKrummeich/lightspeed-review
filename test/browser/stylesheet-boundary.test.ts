import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { renderAnnotationPopup } from "../../src/browser/annotation.ts";
import {
  FORM_PENDING,
  FORM_UNAVAILABLE,
  renderFetchedForm,
} from "../../src/browser/approved-form.ts";
import { renderClosingSummary, type ClosedReview } from "../../src/browser/closing-summary.ts";
import { renderIntent } from "../../src/browser/intent-view.ts";
import { renderOpening, renderSkyNames } from "../../src/browser/opening-view.ts";
import { renderProgressBar } from "../../src/browser/progress-bar.ts";
import { renderReplayOverlay } from "../../src/browser/round-replay.ts";
import { renderStatusBanner, type StatusState } from "../../src/browser/status-banner.ts";
import { renderThreadFoot } from "../../src/browser/thread-foot.ts";
import type { ApprovedFormData } from "../../src/rounds/approved-form.ts";
import type { ReplayComment } from "../../src/rounds/replay.ts";

const ENTRY = new URL("../../src/browser/chrome.css", import.meta.url);
const CSS_DIR = new URL("../../src/browser/css/", import.meta.url);
const CEILING = 300; // the same ceiling eslint.config.js puts on src/**/*.ts

/**
 * Areas allowed past the ceiling, with the size they may not exceed. A budget
 * only ever goes down, and an entry is deleted when its file no longer needs
 * one. New rules go in the area they belong to, never into a file with a
 * budget. The number is content lines, the unit this file measures and the
 * unit eslint's `max-lines` counts.
 *
 * `index.css` held one until the survey's rows moved out to `survey.css`
 * (3.3.0): the chapter index, the focus bar and the file cards had been kept
 * together as one screen, and the rows were the part of it with states of
 * their own. The next area past the ceiling argues its case in this comment.
 */
const REMAINDER_BUDGET: Record<string, number> = {};

function importedNames(): string[] {
  const entry = readFileSync(ENTRY, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...entry.matchAll(/^@import "\.\/css\/([\w.-]+\.css)";$/gm)].map(([, n]) => n ?? "");
}

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

interface AreaOwner {
  module: string;
  area: string;
  /** Must draw one of everything the module emits. */
  render: () => string;
  /** A class the render must contain, so a fixture that draws nothing cannot pass. */
  marker: string;
  /**
   * Classes the module writes only for `dom/` code to find, which no rule
   * paints. Each is checked: a hook the render stops drawing, or one its area
   * starts painting, fails the test, so the list cannot outlive its reason.
   */
  hooks?: readonly string[];
}

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

/** Every part a card can draw: quote, note, and an answer file of each kind. */
const REPLAY_CARD: ReplayComment = {
  id: "c1",
  file: "src/db.ts",
  group: "Schema",
  anchor: null,
  selected_text: "+const x = 1;",
  comment: "rename this",
  status: "addressed",
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
 * The overlay in the three shapes that draw different elements: an answered card
 * with hunks and dots, an unanswered one under the round reply's block, and a
 * card whose commits a rebase took away. One shape leaves the others unguarded.
 */
function replayOverlay(): string {
  const renderer = { renderFile: (diff: string) => `<pre>${diff}</pre>` };
  return [
    renderReplayOverlay(
      { data: { comments: [REPLAY_CARD, REPLAY_CARD] }, current: 0, seen: new Set() },
      renderer,
    ),
    renderReplayOverlay(
      {
        data: { comments: [{ ...REPLAY_CARD, note: undefined, answers: [] }] },
        roundReply: "the round reply",
        current: 0,
        seen: new Set(),
      },
      renderer,
    ),
    renderReplayOverlay(
      {
        data: { comments: [{ ...REPLAY_CARD, state: "unreachable", status: "unknown" }] },
        current: 0,
        seen: new Set(),
      },
      renderer,
    ),
  ].join("");
}

const FETCHED_FORM: ApprovedFormData = {
  path: "src/db.ts",
  paths: ["src/db.ts"],
  from: "1111111aaaaaaa",
  to: "2222222bbbbbbb",
  state: "diff",
  diff: "@@ -1 +1 @@\n-old\n+new",
};

/**
 * Every band the fetched forms draw. The last two are exported markup rather
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
 * The banner in the three shapes that draw its three marks: the reviewer's turn
 * a dot, the agent's a firefly, an ended review the overlay. The overlay's body
 * is the closing summary, which closing.css paints and the closing-summary.ts
 * entry already guards, so it is cut out here: what is left is the markup
 * status-banner.ts writes itself.
 */
function statusBanners(): string {
  const open: StatusState = {
    status: "open",
    agentWaiting: false,
    turn: { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
    review: CLOSED_REVIEW,
  };
  const ended = renderStatusBanner({ ...open, status: "ended" });
  return [
    renderStatusBanner(open),
    renderStatusBanner({ ...open, turn: { holder: "agent", mode: "digesting", at: open.turn.at } }),
    ended.replace(renderClosingSummary(CLOSED_REVIEW), ""),
  ].join("");
}

/**
 * The foot in the two shapes that draw every part: the reviewer's turn draws
 * the box under Resolve and Reply, the agent's working one the waiting line
 * over Resolve alone. A folded thread's Reopen is the same button.
 */
function threadFeet(): string {
  const card = {
    id: "t1",
    label: "src/db.ts",
    main: false,
    messages: [{ role: "reviewer" as const }],
  };
  return renderThreadFoot(card, false, "send") + renderThreadFoot(card, false, "queue");
}

/**
 * Who paints what, module by module: the half of the boundary the import list
 * cannot state. A rule that drifts into another area still reaches the browser
 * — it is served one stylesheet either way — so nothing on screen and no other
 * test says an area has started painting a second module's screen.
 *
 * The emitters not listed here are guarded by nothing; adding one is an entry
 * plus a fixture, where every class the module draws is painted in one area.
 * Measured 2026-09-25, none of the remaining eight qualified; status-banner.ts
 * has since (see its entry), as has thread-foot.ts, which is newer than the
 * count; none of the other seven qualifies as it stands:
 * each wants a decision about where an area's edge runs that this table has
 * no shape for. diff-view.ts, html-template.ts, conversation-panel.ts, round-offer.ts
 * and full-file.ts each draw across two or more areas by
 * design (the `.lsr-switch*` pair sits in code.css and is shared by two
 * modules), and several emit a class no area paints at all
 * (`.lsr-index-item`, `.lsr-focus-prev`, `.lsr-form-option`).
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
    // Two reasons and a chapter is the smallest stack drawing every sheet the
    // opening has: the cover, a reason with a way on, the last reason, and the
    // sky with its held button — plus the names laid over the sky.
    render: () =>
      renderOpening(
        ["sign the tokens", "drop the legacy /login handler"],
        [{ name: "Schema", files: [{ path: "src/db.ts", lines: 4 }] }],
      ) +
      renderSkyNames([
        { chapter: 0, name: "Schema", files: 1, x: 10, y: 10, width: 80, height: 38 },
      ]),
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
  {
    module: "src/browser/intent-view.ts",
    area: "page.css",
    // Both bodies the band can hold: stated reasons draw a list, a round opened
    // before `--intent` was required draws the "none" line instead.
    render: () =>
      renderIntent({ intents: ["sign the tokens"], commits: [] }) +
      renderIntent({ intents: [], commits: ["some commit"] }),
    marker: "lsr-intent-press",
  },
  {
    module: "src/browser/progress-bar.ts",
    area: "page.css",
    // A review with a file draws the bar as well as the count; an empty one
    // draws the count alone, so this one shape reaches every class.
    render: () => renderProgressBar(CLOSED_REVIEW.groups, []),
    marker: "lsr-progress-segment",
  },
  {
    module: "src/browser/annotation.ts",
    area: "popup.css",
    // The popup has one shape: the file list and the quoted selection are drawn
    // for any selection. The textarea and button carry no class: bare element
    // rules paint every one on the page, so there is nothing here to own.
    render: () => renderAnnotationPopup([{ file: "src/db.ts", group: "Schema", text: "+x" }]),
    marker: "lsr-popup-preview",
  },
  {
    // Listed on 2026-09-25 as drawing across areas; it qualified once status.css
    // took the header's presence and the ended overlay out of the conversation
    // column, leaving only the wrapped closing summary outside it.
    module: "src/browser/status-banner.ts",
    area: "status.css",
    render: statusBanners,
    marker: "lsr-ended-overlay",
  },
  {
    module: "src/browser/thread-foot.ts",
    area: "thread-foot.css",
    render: threadFeet,
    marker: "lsr-thread-reply-box",
    // Resolve is painted as the `.lsr-thread-action` it also is; its own class
    // is how panel-mount.ts tells the press from Reply and panel-lock.ts finds it.
    hooks: ["lsr-thread-resolve"],
  },
];

function classesIn(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/class="([^"]+)"/g)].flatMap(([, list]) => (list ?? "").split(" ")),
    ),
  ];
}

/** Comments stripped so a class named in prose does not count as painted. */
function areaRules(area: string): string {
  return readFileSync(new URL(area, CSS_DIR), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Naming the class anywhere is the whole question: an element no rule mentions
 * is an element nobody painted. Which rule paints it is the stylesheet's
 * business, not the test's.
 */
function paints(rules: string, cls: string): boolean {
  return new RegExp(`\\.${cls}(?![\\w-])`).test(rules);
}

test("every class a render module emits is painted in that module's own area", () => {
  for (const { module, area, render, marker, hooks = [] } of AREA_OWNERS) {
    const rules = areaRules(area);
    const classes = classesIn(render());

    assert.ok(classes.includes(marker), `${module}: the fixture rendered no ${marker}`);
    assert.deepEqual(
      classes.filter((name) => !paints(rules, name) && !hooks.includes(name)),
      [],
      `${module} renders classes ${area} does not paint: move the rule into ${area}, or the markup into the module ${area} belongs to`,
    );
    assert.deepEqual(
      hooks.filter((name) => paints(rules, name) || !classes.includes(name)),
      [],
      `${module}: a hook ${area} paints, or the fixture no longer draws, is no hook: drop it from hooks`,
    );
  }
});
