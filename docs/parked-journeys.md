# Parked: journeys and walks

These two phases of the original _Map → Journey → Walk_ plan were specified,
built and shipped, and then retired: the narrated journey over the map and the
walk over a focused chapter did not do the job they were built for. The map —
Phase 1, deterministic and LLM-free — outlived them by a few rounds and was
retired the same way, read in the live product and giving the reviewer nothing;
its spec went with it. So the ground the design below stands on is gone too:
every `.lsr-map*` row, `data-area` attribute and `src/map-area.ts` reference in
it names something the repository no longer has.

What is parked is the _behavioural_ half of the idea: a review tells the
reviewer where a change lives, and it should also tell them what the change
does when it runs. The design below was one answer to that, and it was the
wrong one — a second reading order competing with the chapters, paid for on
every draw. The next attempt should be designed from the question again rather
than resumed from these notes.

They are kept, rather than deleted, because the rulings in them were the
user's and were expensive to reach: the vocabulary that was endorsed, the rule
that a journey may never cost the grouping a repair round, the deterministic
hop verification before anything is stored, and the route line being measured
off the DOM rather than computed.

Nothing here describes code that exists. The sections are the specification as
it stood when the feature was removed, verbatim, plus the one future extension
that assumed them.

---

## Phase 2 — Journeys

Vocabulary ruling: the _city_ metaphor stays banned ("city", "district").
_Journey_, _station_, _route_, _walk_, _protagonist_ were explicitly endorsed
by the user and are product vocabulary.

### LLM output (same grouping call, one response)

`GROUPING_SCHEMA` gains an optional top-level `journeys`:

```ts
journeys?: {
  protagonist: string;        // "an annotation", "a round record"
  stations: {
    name: string;             // "Recorded" — one word or two
    tells: string;            // one sentence: what happens to the protagonist here
    group: string;            // must equal an existing group name
  }[];                        // 2–6 stations
}[];                          // 0–3 journeys, primary first
```

Validation (`validateGroupingReply`): journeys are best-effort and must never
degrade grouping — no repair rounds on their account. Rules, applied in
order: a station whose `group` names no existing group is dropped; a journey
left with < 2 stations is dropped; journeys beyond the first 3 are dropped;
if `journeys` is malformed as a whole, it is stripped and groups stand alone.
Fallback/skipped grouping ⇒ no journeys. Prompt guidance (system prompt):
narrate the concrete datum, not the modules; only emit a journey when the
change genuinely tells one; fewer, truer stations beat coverage.

### Transport & persistence

Mirror `groups` end to end: `runStart` posts `journeys` (after dropping any
that validation would), `parseCreateSession` re-validates structurally,
`SessionRecord.journeys?` / `SessionData.journeys?` carry them, refreshed
every round, absent ⇒ Phase 1 screen exactly.

### Opening-screen UI

Between intent and map when journeys exist:

- One journey: a lead line — "Follow _⟨protagonist⟩_ — N stations."
- Several: a button row (house index-nav pattern, `data-journey-index`), one
  active at a time; switching redraws stations + route line.
- Station cards under the map (grid row, like the chapter index): numbered,
  `name`, `tells`, group linkage via `data-group-index` → click focuses the
  chapter (existing focus mechanics). Card of a station whose group is fully
  approved renders `data-state="done"`.

### The route line (answers the user's open question)

The line is **measured, not computed**: rows sit wherever the tree's columns
fold them, so after each draw a small DOM module
(`src/browser/dom/route-overlay.ts`):

1. Maps each station → area row: station's group's first changed file →
   the same longest-prefix fallback the map overlay buckets with
   (`areaHomeOf`, shared `src/map-area.ts`) → row matched by
   `.lsr-map-area[data-area]` — the attribute rides every area row;
   directory rows carry their segment's `data-area` too, so matching filters
   by area-row class and a key only a directory row holds falls through like
   any unnamed area.
2. Measures row centers with `getBoundingClientRect` relative to the map
   tree (`.lsr-map-tree`).
3. Draws one absolutely-positioned `<svg>` overlay (`pointer-events: none`)
   over the tree: a dashed cubic path through the centers in station order,
   numbered dots at each station (`--sol-magenta` family).
4. Consecutive stations on the same row collapse to one dot with stacked
   numbering ("2·3"); a station whose area has no row falls through its
   shorter prefixes, then to the `…` row, or is skipped from the line (dot
   appears on its card only).
5. Redraws on `ResizeObserver` of the map tree and on every `draw()`.

No layout library, no precomputed coordinates, deterministic given the DOM.

## Phase 3 — Walks

### LLM output

Each station MAY carry hops:

```ts
hops?: {
  symbol: string;   // function/method name as it appears in the diff
  file: string;     // changed file path
  why: string;      // one clause: what this hop does to the protagonist
}[];                // 3–6; a station needing more must be split into two
```

### Verification (deterministic, before anything is stored)

In `runStart`, after grouping: a hop survives only if `file` is a changed
path in that station's group AND `symbol` occurs verbatim in that file's
`diff` text (plain substring; hunk headers' function-context suffixes count).
A station keeping < 2 hops loses its walk (station itself stays). Dropped
hops are logged to stderr, never repaired. The browser trusts stored hops.

### UI

- Station cards with a surviving walk grow a "Walk →" affordance (separate
  from the card's focus-group click).
- Walking a station enters the existing focus mode on its group with two
  additions: a walk bar above the group listing the hops in order
  (numbered, `symbol · file`, `why` as title tooltip; click scrolls to that
  file's section), and **file sections of the focused group reorder to hop
  order** (files not named by any hop follow after, original order kept).
  Hunks inside a file keep their order. Leaving focus restores normal order.
- Approval semantics unchanged — walking is a lens, chapters stay the unit.

## Grading (Phase 2/3, follow-up work)

Journey fixtures can reuse the grouping harness shape (ordered named lists →
ARI + tau) and the pairwise LLM judge; not built yet.

## Future extensions (recorded, never built)

- **Full hunk-level execution reorder**: Phase 3 reorders file sections; true
  cross-file hunk interleaving by call order is deliberately deferred.
