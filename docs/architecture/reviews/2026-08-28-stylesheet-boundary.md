# The stylesheet is the one module with no boundary

- **Date:** 2026-08-28
- **Status:** Adopted — implementation in progress
- **Scope:** `src/browser/chrome.css`, its 15 rendering modules, `test/browser/chrome-css.test.ts`

## 1. Context

Repository history at the time of writing: 353 commits, 2026-07-24 → 2026-08-27
(~5 weeks). 350 of them touch `src/` or `test/`. What the module- and file-level
history says:

| Signal                                           | Number                                      |
| ------------------------------------------------ | ------------------------------------------- |
| `src/browser/chrome.css` size                    | **2,916 lines** — largest file in the repo  |
| Its commits in the window                        | **92**                                      |
| Share of all `src`/`test` commits                | **26%** (92 / 350)                          |
| Share of every commit touching `src/browser`     | **55%** (92 / 166)                          |
| Distinct files that co-change with it            | **170** (23 of them ≥ 5 times)              |
| Growth                                           | 132 lines (2026-07-25) → 2,916 (2026-08-26) |
| Its guard test `test/browser/chrome-css.test.ts` | 0 → 668 lines, 38 commits                   |

Cross-file temporal coupling (180d; `support` = co-changes / commits of the
rarer file). `chrome.css` is one side of **6 of the 10 strongest pairs in the
repository**:

```
co_changes  support  pair
36          0.95     src/browser/chrome.css      ↔ test/browser/chrome-css.test.ts
29          0.64     src/browser/chrome.css      ↔ src/browser/dom/diff-mount.ts
28          0.61     src/browser/chrome.css      ↔ src/browser/diff-view.ts
27          0.68     src/browser/chrome.css      ↔ test/browser/diff-view.test.ts
21          0.58     src/browser/chrome.css      ↔ src/browser/dom/main.ts
20          0.91     src/browser/chrome.css      ↔ src/html-template.ts
18          0.78     src/browser/chrome.css      ↔ test/html-template.test.ts
```

The 0.91 with `src/html-template.ts` is the highest cross-module support in the
repo outside source↔own-test pairs: 20 of the 22 commits that touch the
server-rendered shell also touch the browser stylesheet. At module zoom this is
the `src ↔ src/browser` pair (51 co-changes, support 0.42) and `src/browser`'s
0.84 cross-change share — but the module numbers hide who is doing it. One file
is.

## 2. Finding

**`src/browser/chrome.css` is a shared module that no rule, no ceiling and no
owner applies to, and it is the repository's #1 churn hotspot.** Three concrete
symptoms, read out of the code rather than the tables:

**(a) The repo's own size doctrine structurally cannot see it.**
`eslint.config.js` sets `"max-lines": ["error", { max: 300 }]` for
`src/**/*.ts` and `scripts/**/*.ts`, with a written rationale — _"Files get 300
content lines before they are doing more than one job"_ — and a three-file
exception list (`src/config.ts`, `src/ledger/records.ts`,
`src/ledger/export.ts`) whose comment demands that _"the next 300-line file has
to argue its case in this comment."_ ESLint does not parse CSS. `chrome.css` is
**9.7× the ceiling** and has never had to argue its case. The doctrine is about
files doing one job; only its enforcement is about TypeScript.

**(b) 15 modules depend on it through unchecked string literals; 3 are guarded.**
Files emitting `class="…lsr-…"` literals, and their commit counts:
`src/browser/round-replay.ts` (34 literals), `diff-view.ts` (28 literals, 46
commits), `conversation-panel.ts` (27, 15), `src/html-template.ts` (15, 22),
`opening-view.ts` (12), `group-index.ts` (10), `approved-form.ts` (10),
`round-offer.ts` (8), `closing-summary.ts` (8), `focus-mode.ts` (6),
`full-file.ts` (5), `progress-bar.ts` (4), `intent-view.ts` (4),
`status-banner.ts` (3), `annotation.ts` (2). Against 146 distinct `.lsr-*`
classes in 287 rule blocks, nothing maps a class to the file that paints it or a
rule back to the module that emits it.

The team already knows this is the risk: `test/browser/chrome-css.test.ts`
hand-writes exactly three coverage guards — _"every class the closing summary
renders is a class this file styles"_, and the same for the replay overlay and
the opening. The other twelve emitters, including the highest-churn one
(`diff-view.ts`, 46 commits), have none. A guard written per feature instead of
per boundary does not scale, and the guard file shows it: 668 lines whose
helpers `rulesFor()` and `placementsOf()` re-parse the entire stylesheet with
regexes on every assertion, because there is nothing smaller to parse.

**(c) The file is where the areas were never separated.** The rules are already
laid out area by area — tokens `1–215`, page shell `252–461`, panel `498–594`,
index/file/group/tick `471–1166`, popup/prompt `1199–1535`, closing `1647–1733`,
diff2html + highlight.js `1832–2025`, replay `2035–2302`, opening `2499–2883`,
and one cross-area `@media (prefers-reduced-motion: reduce)` block at
`2863–2916`. The boundaries exist in the author's head and in the section
comments; they exist nowhere a machine can check them, so every UI feature edits
the same file and 55% of browser commits pass through this single point. That is
the hotspot shape that predicts defects, and it is why six of the ten strongest
file pairs in the repo have `chrome.css` on one side.

**Blast radius:** `src/browser` (63 files, 9,632 LOC, 166 commits/90d) plus the
server-rendered shell `src/html-template.ts` and its tests. Every UI change
lands here.

## 3. Proposal

### Target state

`src/browser/chrome.css` **keeps its name and its role as the entry** — it is
imported by `src/browser/dom/main.ts:2` (`import "../chrome.css";`), bundled by
`scripts/build.ts` into `dist/browser/app.css`, required by
`src/static-assets.ts` (`REQUIRED_ASSETS`), linked by `src/html-template.ts:22`,
and named in `docs/wireframes.md` — but it contains nothing except a header
comment and an ordered `@import` list. Area stylesheets live in
`src/browser/css/<area>.css`, each ≤ 300 content lines, each named for the
render modules whose classes it paints:

```
src/browser/chrome.css        entry: comment + @import list, cascade order
src/browser/css/tokens.css    :root palette, type and spacing scales
src/browser/css/page.css      header, review column, intent, progress
src/browser/css/panel.css     conversation panel frame and rail
src/browser/css/index.css     chapter index, file/group cards, ticks
src/browser/css/popup.css     annotation popup and prompt quoting
src/browser/css/conversation.css  entries, pills, compose, working marker
src/browser/css/round.css     round offer, card, announcement
src/browser/css/closing.css   closing summary
src/browser/css/code.css      diff2html + highlight.js overrides
src/browser/css/replay.css    replay overlay
src/browser/css/opening.css   opening sheets
src/browser/css/motion.css    the one prefers-reduced-motion block, imported last
```

**Verified property that makes this safe:** esbuild inlines relative `@import`s
in order. Splitting the file in a scratch copy of the repo and rebuilding
produced a `dist/browser/app.css` **byte-identical** to the committed one
(`cmp`, 53,605 bytes, verified 2026-08-28). Every step below therefore has an
exact oracle: _the built stylesheet must not change by a single byte._

### Stepwise plan

Each step is behaviour-preserving and sized for one daily run.

1. **Read the stylesheet through a helper.** Add `test/helpers/stylesheet.ts`
   exporting `stylesheet()` (the entry's `@import`s read and concatenated in
   order) and `stylesheetParts()`. Point the ~40 assertions in
   `test/browser/chrome-css.test.ts` at `stylesheet()` instead of
   `readFileSync(".../chrome.css")`. With no imports in the entry yet the helper
   returns the file itself, so nothing changes. _Gate: `pnpm test`._
2. **Make the entry an entry.** `git mv src/browser/chrome.css
src/browser/css/base.css`; write `chrome.css` as a comment plus
   `@import "./css/base.css";`. Rename detection keeps the diff at a handful of
   lines. Confirm `dist/browser/app.css` is byte-identical to the previous
   build. _Gates: all four._
3. **Land the fitness function** (section 4) with `base.css` recorded in its
   budget table at its current size. From this commit on, the boundary is
   machine-checked and the remainder can only shrink.
4. **Split one area per run**, in this order — smallest and most self-contained
   first: `code.css`, `motion.css`, `opening.css`, `replay.css`, `closing.css`,
   `round.css`, `conversation.css`, `popup.css`, `panel.css`, `index.css`,
   `page.css`, `tokens.css`. Each step moves one contiguous block, adds its
   `@import` in the _same cascade position_, lowers `base.css`'s budget by the
   moved amount, and `cmp`s the built `app.css`. Blocks larger than the daily
   diff limit split at a rule boundary across two runs; the budget makes a
   half-moved area safe to leave overnight. When `base.css` reaches zero, delete
   it and its budget entry.
   _Constraint discovered while reading:_ the `prefers-reduced-motion` block is
   cross-area and the existing guard
   (`/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\n\}/`) assumes there
   is exactly one of it. Move it whole into `motion.css`, imported last; do not
   distribute it per area.
5. **Follow-on, one module per run:** replace the three hand-written coverage
   guards with the table-driven ownership test in section 4, adding one area to
   the table as each area file lands.

## 4. Fitness function

A new `test/browser/stylesheet-boundary.test.ts` — `node:test` and `node:fs`
only, no new dependency, matching how this repo already guards this file. Three
assertions lock the boundary; the fourth arrives with step 5.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const ENTRY = new URL("../../src/browser/chrome.css", import.meta.url);
const CSS_DIR = new URL("../../src/browser/css/", import.meta.url);
const CEILING = 300; // the same ceiling eslint.config.js puts on src/**/*.ts

/**
 * Files still holding un-split chrome.css, with the size they may not exceed.
 * A budget only ever goes down — every split step lowers it — and the entry is
 * deleted when the file is. New rules go in an area file, never here.
 */
const REMAINDER_BUDGET: Record<string, number> = { "base.css": 2916 };

function importedNames(): string[] {
  const entry = readFileSync(ENTRY, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...entry.matchAll(/^@import "\.\/css\/([\w.-]+\.css)";$/gm)].map(([, n]) => n ?? "");
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
    const lines = readFileSync(new URL(name, CSS_DIR), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => l.trim() !== "").length;
    const budget = REMAINDER_BUDGET[name] ?? CEILING;
    return lines > budget ? [`${name}: ${lines} > ${budget}`] : [];
  });
  assert.deepEqual(over, [], `split an area out, or argue the case here:\n${over.join("\n")}`);
});
```

Step 5 adds the ownership lock, which is what stops the areas re-merging:

```ts
/** Which stylesheet paints the classes each renderer emits. A literal map: the
 *  class name in the module, the file name on disk, both greppable. */
const AREA_OWNERS: Record<string, string> = {
  "src/browser/diff-view.ts": "index.css",
  "src/browser/conversation-panel.ts": "conversation.css",
  // …one entry per renderer, added as its area lands
};

test("every class a renderer emits is painted in that renderer's area", () => { … });
```

Every assertion fails loudly at `pnpm test`, which already runs in the gate set.

## 5. Alternatives rejected

- **Leave it whole — CSS churn is just UI churn.** The number that refuses this
  is 55%: over half of every commit touching `src/browser` passes through one
  file, and it is one side of six of the ten strongest coupling pairs in the
  repo. The repo's own written doctrine says a file past 300 content lines is
  doing more than one job; this one is doing about twelve.
- **Generate CSS from TypeScript (CSS-in-JS, co-located style constants).**
  Rejected: `docs/wireframes.md` is a design brief written _for a design agent_
  around "the one stylesheet is `src/browser/chrome.css`" and the class names
  that paint each frame. Moving rules into TS destroys that artifact and fails
  the grep test — a class name would stop being a literal findable in one place.
  It is also a rewrite, not a migration.
- **Adopt stylelint with a max-lines plugin.** Rejected: a new devDependency and
  a new gate to express one rule the repo can state in 40 lines of `node:test`,
  which is exactly how it already guards this stylesheet.
- **One stylesheet per render module (15+ files).** Rejected: several rules
  legitimately span areas — `.lsr-group:has(.lsr-tick-all:checked) .lsr-file`
  is one — and per-module files would force each into an arbitrary home. ~12
  areas keep every such rule inside one file and match how `docs/wireframes.md`
  already organises the UI into numbered screens.
- **Split it in one commit.** Rejected: ~2,900 moved lines is far past the daily
  agent's 200-line diff limit and past cheap review. Worse, without the budget
  ratchet a half-finished split silently re-merges — the failure mode that
  produced the current file.

## 6. Non-goals

- **No restyling.** No rule is renamed, merged, de-duplicated or re-valued.
  Every step must leave `dist/browser/app.css` byte-identical; a step that
  cannot is a different proposal.
- **Not splitting `test/browser/chrome-css.test.ts`** (668 lines) yet. It
  follows its subject once the areas exist, and it is exempt from `max-lines`
  today by deliberate policy.
- **Not `test/server.test.ts`** (1,974 lines, 48 commits; `src/server/` is the
  only source module with no mirrored test directory). Second on this week's
  list, and a candidate for a future review.
- **Not the stale file tree in `spec.md`** (`src/browser/chrome.ts`, "Tailwind
  CSS (CDN)" at line 55). Doc decay, daily-agent sized.
- **No change to the Node ⇄ browser boundary.** It was examined and is healthy:
  `eslint.config.js` already restricts imports of `src/browser/dom/**`, esbuild
  fails the build on a value import of Node-only code from the bundle (verified
  by experiment), and `src/rounds/replay.ts` importing `src/browser/conversation-rounds.ts`
  is the sanctioned "everything may import the pure renderers" direction.
