# Lightspeed — UI wireframes

Every screen and popup the review page has today, as ASCII wireframes with the
class names that paint them. Written as a brief for a design agent: **the
layout is fixed — restyle color, surface, shadow, and type treatment only.**
The one stylesheet is `src/browser/chrome.css`; markup comes from the pure
renderers named next to each frame.

---

## 1. Page frame

One CSS grid on `<body>`: columns `minmax(0,1fr) auto 22rem`, rows
`auto minmax(0,1fr)`, `height: 100vh`. Header spans all columns; everything
else is out-of-flow overlays.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ HEADER  .lsr-header                          (grid row 1, spans 3 cols)  │
├─────────────────────────────────────────────────┬───┬────────────────────┤
│ REVIEW COLUMN  main#lsr-review  (scrolls)       │ R │ CONVERSATION PANEL │
│                                                 │ A │ aside#lsr-panel    │
│   section#lsr-intent   (survey mode only)       │ I │ fixed 22rem/352px  │
│   div#lsr-diff         (index OR one chapter)   │ L │ (collapsible)      │
│                                                 │   │                    │
└─────────────────────────────────────────────────┴───┴────────────────────┘
  out of flow: #lsr-opening  #lsr-replay  #lsr-round-popup  #lsr-done-popup  (classless ids)
```

- Rail `#lsr-panel-rail`: thin full-height button between diff and panel,
  `›`/`‹` glyph, small badge showing queued-comment count. Toggles
  `body[data-panel="open"|"collapsed"]`; collapsed sets the third column to 0.
- Overlay z-order: annotation popup **10** (position:absolute, no scrim) →
  opening **18** = replay **18** → round popup **19** → ended **20**. All
  full-screen overlays dim the page with `--lsr-scrim`.
- Two color schemes, "Porcelain & Cobalt" light/dark, switched via
  `:root[data-color-scheme]` + `color-scheme` (see §11).

## 2. Header — `.lsr-header` (html-template.ts, progress-bar.ts, round-offer.ts, status-banner.ts)

One baseline-aligned flex row:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ feature-branch ←main  [▓▓▓▓│▓▓░░│(░░)│▓░░░]  12/40 files approved        │
│  h1  .lsr-base        .lsr-progress-bar        .lsr-progress-count       │
│                                                                          │
│ [Unified│Side-by-side] [scheme]  (Replay last round) (Round 2 is ready   │
│  #lsr-view-switch  #lsr-scheme-switch  #lsr-replay-reopen   · 5 files)   │
│                                              #lsr-round-offer            │
│ status line · presence sentence                     #lsr-status-banner   │
└──────────────────────────────────────────────────────────────────────────┘
```

- Progress bar: one `.lsr-progress-segment` per chapter, width ∝ changed
  lines, `data-state="approved|partial|untouched"`, inner `.lsr-progress-fill`
  at approval %. The focused chapter's segment carries `data-current` — an
  accent outline ring. A swept chapter (§3) carries `data-tier="sweep"`: its
  empty slot is hatched in `--lsr-border` instead of filled with it, so the bar
  says where the reading is and not only how much of it is left. The approval
  fill runs over it unchanged.
- `#lsr-replay-reopen` and `#lsr-round-offer` are hidden until relevant.
- Round-offer states: plain → **glow** (`lsr-offer-glow`, after the round
  popup folds into it) → **beckon** (orbiting spark via `::after` +
  `offset-path: border-box`, `data-beckon`).

## 3. Survey mode — chapter index (intent-view.ts, group-index.ts)

Default view, no chapter focused. Intent block + pressable chapter list.
No diffs on screen.

```
┌─ main#lsr-review ────────────────────────────────────────────┐
│  What this change is for                  .lsr-intent-title  │
│  • first stated intent                    .lsr-intent-item   │
│  • second stated intent                                      │
│    (or: "This round was opened without a stated intent.")    │
│                                                              │
│  ┌─ nav.lsr-index ────────────────────────────────────────┐  │
│  │ ┌─ button.lsr-index-entry ───────────────────────────┐ │  │
│  │ │ Chapter name     3 files   +120 −8    1/3 approved │ │  │
│  │ │ [Densest logic]                                    │ │  │
│  │ └────────────────────────────────────────────────────┘ │  │
│  │ ┌────────────────────────────────────────────────────┐ │  │
│  │ │ Another chapter  2 files   +40 −2     0/2 approved │ │  │
│  │ └────────────────────────────────────────────────────┘ │  │
│  │ ──────────────────────────────────────────────────────  │
│  │ ┌─ section.lsr-sweep ────────────────────────────────┐ │  │
│  │ │ Mechanical — 27 files, nothing to decide           │ │  │ .lsr-sweep-heading
│  │ │ ┌────────────────────────────────────────────────┐ │ │  │
│  │ │ │ Renamed modules 25 files  +0 −0   0/25 approved│ │ │  │ .lsr-index-entry
│  │ │ └────────────────────────────────────────────────┘ │ │  │
│  │ │ ┌────────────────────────────────────────────────┐ │ │  │
│  │ │ │ Docs             2 files  +40 −2   0/2 approved│ │ │  │
│  │ │ └────────────────────────────────────────────────┘ │ │  │
│  │ │ ( Approve 27 files )                               │ │  │ .lsr-sweep-approve
│  │ └────────────────────────────────────────────────────┘ │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

Classes per entry: `.lsr-index-name` `.lsr-index-files` `.lsr-index-lines`
`.lsr-index-counter` `.lsr-index-logic` (badge, densest chapter only, and never
a chapter in the sweep lane). The whole
row is one button → enters focus mode. **A row says how big a chapter is, never
what it is for**: the rationale is said once, at full size, on the chapter's own
gate (§4) — a clamped grey copy of it here was a line nobody read.

**The sweep lane** (`section.lsr-sweep`, painted by `css/sweep.css`) holds every
chapter whose tier is `sweep` — bulk with nothing to decide — under one heading
naming the total, below the chapters to study and in their own order. The rows
inside it are the same `.lsr-index-entry` buttons and enter focus mode exactly
as the ones above; only where they are read has changed. `.lsr-sweep-approve` is
the one press: it ticks every file of every swept chapter at once, through the
same approve POST as a single checkbox, and it is a union rather than a toggle —
a second press changes nothing. A review with no swept chapter has no lane at
all, not an empty one. The header bar marks the same chapters by hatching their
segments (§2).

## 4. Focus mode — one chapter, its gate and its diff (focus-mode.ts, diff-view.ts)

Intent block hides; a focus bar tops the single focused chapter. Every way into
a chapter — an index entry, a header segment, Previous/Next, re-entering the one
just left — lands on its gate: the chapter's intent alone on the screen, its
diff rendered but shut behind one press.

```
┌─ main#lsr-review ─────────────────────────────────────────────────┐
│ ‹ All chapters                    Chapter 2 of 5  [Previous][Next]│ .lsr-focus-bar
│ ┌─ section.lsr-group ─────────────────────────────────────────┐   │
│ │ ┌─ .lsr-gate (centred) ───────────────────────────────────┐ │   │
│ │ │                     Chapter name                        │ │   │ .lsr-gate-name (title)
│ │ │             What happened, one sentence.                │ │   │ .lsr-gate-rationale (lead)
│ │ │               src/path/file.ts   +12 −3                 │ │   │ .lsr-gate-files / -file
│ │ │               src/other.ts       +4 −0                  │ │   │ .lsr-gate-path / -lines
│ │ │                     1/3 approved                        │ │   │ .lsr-gate-counter
│ │ │                   ( Read the diff )                     │ │   │ .lsr-gate-press
│ │ └─────────────────────────────────────────────────────────┘ │   │
│ │                                       approve chapter [ ]   │   │ .lsr-group-foot
│ └─────────────────────────────────────────────────────────────┘   │ .lsr-tick-all
└───────────────────────────────────────────────────────────────────┘
```

Pressed — the button or anywhere on the card — the card goes and the room it
held is the diff's:

```
┌─ main#lsr-review ─────────────────────────────────────────────────┐
│ ‹ All chapters                    Chapter 2 of 5  [Previous][Next]│ .lsr-focus-bar
│ ┌─ section.lsr-group ─────────────────────────────────────────┐   │
│ │ ┌─ .lsr-group-content ────────────────────────────────────┐ │   │
│ │ │ ┌─ .lsr-file (open) ──────────────────────────────────┐ │ │   │
│ │ │ │ ▾ src/path/file.ts  +12 −3   changed after approval │ │ │   │ .lsr-file-header
│ │ │ │   [Branch diff│Since approval]                      │ │ │   │ .lsr-form-switch
│ │ │ │ ┌─ .lsr-file-diff ────────────────────────────────┐ │ │ │   │
│ │ │ │ │  10  10   context line                          │ │ │ │   │
│ │ │ │ │  11       - removed line                        │ │ │ │   │
│ │ │ │ │      11   + added line                          │ │ │ │   │
│ │ │ │ └─────────────────────────────────────────────────┘ │ │ │   │
│ │ │ │                                      approve [ ]    │ │ │   │ .lsr-file-foot
│ │ │ └─────────────────────────────────────────────────────┘ │ │   │
│ │ │ ┌─ .lsr-file (approved → diff folded) ────────────────┐ │ │   │
│ │ │ │ ▸ src/other.ts  +4 −0                approve [x]    │ │ │   │
│ │ │ └─────────────────────────────────────────────────────┘ │ │   │
│ │ └─────────────────────────────────────────────────────────┘ │   │
│ │                                       approve chapter [ ]   │   │ .lsr-group-foot
│ └─────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

- The gate is the chapter's shut state, not a screen of its own: the press is
  the group's fold (`aria-expanded`/`aria-controls` on `.lsr-gate-press`,
  `.lsr-group-content` hidden behind it), and the card is drawn only while that
  fold is shut. So ticking the chapter's own box shuts it back onto its card.
  Unticking it opens nothing: an untick is a withdrawal, not a request to
  read, so the card stays a card and the diff opens on its own press alone.
- Every card offers the chapter's tick, at its foot as the diff's foot does:
  a chapter is settled from its card as well as from under its lines, and an
  approved chapter's card shows the same box ticked — the mark is the
  chapter's state, and the card is where that state has to be legible. The
  tick and its label are a press of their own: the card around them opens the
  diff, they never do. A sweep chapter's card says why its tick is the press
  to make, under a `.lsr-gate-tier` label in the survey lane's words: there is
  nothing in it to decide.
- The card is centred, column and lines both, the way a chapter of a book
  opens; hugging the left edge it read as one more paragraph of the page.
- A tick that finishes the focused chapter moves on: the next chapter in order
  with something still unticked takes the screen, on its gate, wrapping round.
  Sweep chapters are landed on like any other — one press on their card
  settles them. With nothing left to read, the finished card stays, mark and
  all.
- Passing a gate is view state and nothing more: it is never sent to the server
  and never stored per file. It survives a redraw inside the round (an agent
  reply must not put the card back over a half-read diff) and a reload, which
  restores the reviewer's place; every chapter move renders it shut again.
- The chapter's name is on its card and nowhere else. The focus bar is
  navigation and says only the chapter's place — said on both, the name was
  the one thing on the screen written twice — and nothing above the first
  file says what the chapter is for, which is exactly what the gate is for.
- Both ticks close what they mark: `approve` at the file **foot**, below its
  diff, and `approve chapter` at the chapter's, below the last file —
  deliberate, you approve what you have read past.
- Diff body: unified or side-by-side (header switch), line numbers both
  sides, word-level highlights; binary files say
  "Binary file — no diff to show."
- File-header badges (inline spans): `renamed from …`, logic badge,
  `commented last round`, `changed after approval`.
- Per-file form switch appears only when the file has a second diff to show:
  `[Branch diff│Since approval]` (approved file changed afterwards) or
  `[Branch diff│Since last round]` (file edited between the last two rounds).
  "Branch diff" is always the initially-pressed option. Fetched views can show
  pending/missing notes and "Feedback is off in this view … press Branch diff
  to leave one." — selection-annotation works on the branch diff only.

## 5. Conversation panel — `aside#lsr-panel` (conversation-panel.ts, panel-mount.ts)

Fixed 352px right column. Scrolling history + queue above a pinned compose box.

```
┌─ aside#lsr-panel ──────────────────────────┐
│ ┌ .lsr-panel-scroll ─────────────────────┐ │
│ │ ── Round 1 · earlier round ──          │ │ .lsr-round-mark (separator,
│ │                                        │ │  only when >1 round on screen)
│ │ reviewer                               │ │ .lsr-entry-role
│ │ ┌ article.lsr-entry ─────────────────┐ │ │
│ │ │ [file.ts]           ← basename btn │ │ │ .lsr-prompt-file (full path
│ │ │ │ quoted selected text             │ │ │  in tooltip; press jumps to
│ │ │ comment text                       │ │ │  the diff line)
│ │ │ ─────────── hairline seam ──────── │ │ │ .lsr-prompt-selection (pre)
│ │ │ second prompt of the same turn…    │ │ │ .lsr-prompt-comment
│ │ └────────────────────────────────────┘ │ │
│ │ agent                                  │ │
│ │   reply text                           │ │
│ │ ●●● the agent is working on your       │ │ .lsr-working (animated dots;
│ │     feedback                           │ │  gone once review ends)
│ │                                        │ │
│ │ ┌ section.lsr-queue ─────────────────┐ │ │
│ │ │ ┌ .lsr-pill ───────────────────┐   │ │ │
│ │ │ │ (round 1) [file.ts]      [×] │   │ │ │ .lsr-pill-round (stale badge)
│ │ │ │ │ selection                  │   │ │ │ .lsr-pill-remove
│ │ │ │ comment                      │   │ │ │
│ │ │ └──────────────────────────────┘   │ │ │
│ │ │ or: "Nothing queued — select diff  │ │ │ .lsr-empty
│ │ │      text to add feedback."        │ │ │
│ │ └────────────────────────────────────┘ │ │
│ └────────────────────────────────────────┘ │
│ ┌ section.lsr-compose (pinned) ──────────┐ │
│ │ Every file is approved — Send & End    │ │ .lsr-complete (conditional)
│ │ when you are ready.                    │ │
│ │ [General comment — Enter sends…      ] │ │ #lsr-general-comment
│ │ [Send to Agent]         [Send & End]   │ │ #lsr-send (.lsr-primary)
│ └────────────────────────────────────────┘ │ #lsr-send-end (.lsr-secondary)
└────────────────────────────────────────────┘
```

States: sending — primary reads "Sending…", all compose controls disabled;
ended — "This review has ended.", textarea disabled. The rail auto-reopens a
shut panel when the agent replies or when approval crosses done.

## 6. Annotation popup — `.lsr-popup` (annotation.ts, dom/annotation-popup.ts)

Floats at the diff selection (position:absolute, z10, no scrim). Trigger:
mouseup on a non-empty selection inside the branch diff.

```
          ┌ .lsr-popup ─────────────────────────┐
          │ src/path/file.ts                    │ .lsr-popup-files
          │ │ selected diff text (≤200 chars)   │ .lsr-popup-preview
          │ ┌─────────────────────────────────┐ │
          │ │ Type feedback, then press Enter │ │ #lsr-annotation-comment
          │ └─────────────────────────────────┘ │
          │                  [Queue Feedback]   │ #lsr-queue-feedback
          └─────────────────────────────────────┘
```

Enter queues (pill appears in the panel), Shift+Enter is a newline, clicking
elsewhere dismisses.

## 7. Opening overlay — round 0 ceremony (opening-view.ts, dom/opening-overlay.ts)

Full-screen "unlit room": darker-than-page field, gold lamp beam in dark
scheme / darkened paper edges in light, drifting motes. Shown once, on a
review's first round, only if intents were stated. One sheet at a time.

```
┌ .lsr-opening-overlay ──────────────────────────────────────┐
│      ·      ·   (motes drifting)    ·          ·           │
│                                                            │
│                    FROM YOUR AGENT             .lsr-opening-lead
│            Something was built for you         .lsr-opening-headline
│           Two reasons, one at a time.          .lsr-opening-body
│                                                            │
│                     ( Unwrap )                 .lsr-opening-press
│                                                            │
│                       ● ○ ○                    .lsr-opening-dots
└────────────────────────────────────────────────────────────┘

reason sheets (one per intent, same room):
│           The intent text, set large,          .lsr-opening-body
│           nearly headline size, ≤30ch          (reason size)
│                                                            │
│          ( Next reason │ Open the review )     last sheet opens
```

- Sheets cross mid-room: leaving lifts up+fades, arriving rises from below
  (`data-at="top|under|gone"`). Press flash `data-flare`; final press floods
  the room `data-bloom` then closes. Esc skips at any point.
- The stack grows with the longest reason (floor 19rem, ceiling = viewport);
  the button is pushed down rather than the text scrolling.

## 8. Round popup + header offer (round-offer.ts, dom/round-popup.ts)

A new round arriving mid-read is announced once by a modal card — only if the
reviewer is actually engaged (scrolled, in a chapter, or has queued words);
otherwise the round just applies.

```
┌ .lsr-round-overlay (scrim, z19) ───────────────────┐
│          ┌ .lsr-round-card ─────────────────┐      │
│          │ Round 2 is ready                 │      │ .lsr-round-title
│          │ 5 files                          │      │ .lsr-round-size
│          │ Take it now, or keep reading —   │      │ .lsr-round-note
│          │ it will wait in the header.      │      │
│          │                                  │      │
│          │ [Open round 2]   [Keep reading]  │      │ .lsr-round-take /
│          └──────────────────────────────────┘      │ .lsr-round-stay
└────────────────────────────────────────────────────┘
```

"Keep reading" / Esc folds the card toward the header (260ms,
`data-state="folding"`); the header offer chip then glows and later sends an
orbiting spark around its border. Taking the round from either place clears
both.

## 8a. Finish card (review-done.ts, dom/done-popup.ts, dom/finish.ts)

The tick that approves the last file puts a card up over the review — the
sidebar's "Every file is approved — Send & End when you are ready" note sits in
a column the eye left an hour ago. Same scrim, layer and card as §8; below the
ended overlay, whose word is last.

```
┌ .lsr-done-overlay (scrim, z19) ────────────────────┐
│          ┌ .lsr-done-card ──────────────────┐      │
│          │ (✓)                              │      │ .lsr-done-mark (accent badge)
│          │ NOTHING LEFT TO READ             │      │ .lsr-done-eyebrow
│          │ Every file is approved           │      │ .lsr-done-title
│          │ End the review to hand it back   │      │ .lsr-done-note
│          │ to the agent, or keep looking —  │      │  (+ "Your 2 queued notes
│          │ nothing is sent until you say so.│      │    go with it." when queued)
│          │                                  │      │
│          │ [End review]   [Keep looking]    │      │ .lsr-done-end /
│          └──────────────────────────────────┘      │ .lsr-done-stay
└────────────────────────────────────────────────────┘
```

- Goes up on the crossing only (`approval-crossing.ts`): a page that opens
  fully approved says nothing, and a finish that comes undone — a round took
  the page, a box came unticked in another tab — takes its card down.
- "End review" is the panel's own Send & End (`MountedPanel.end`): queue and
  general comment go with it, the page locks, the closing summary follows.
  "Keep looking" / Esc take the card down and send nothing. Focus is a
  dialog's: the end press takes the caret, the previous holder gets it back.
- Motion: arrive as §8, one glow, the mark lands a beat later; all still under
  `prefers-reduced-motion`.

## 9. Replay overlay — between rounds (round-replay.ts, dom/replay-overlay.ts)

For rounds > 0: what became of each comment from the previous round, one card
at a time, before the new diff is read. Never shown together with §7.

```
┌ .lsr-replay-overlay (z18) ─────────────────────────────────┐
│   BETWEEN ROUNDS                        Comment 2 of 4     │ .lsr-replay-eyebrow / -progress
│   ┌ article.lsr-replay-card ───────────────────────────┐   │
│   │ src/path/file.ts                     [addressed]   │   │ .lsr-replay-path + -chip
│   │                                                    │   │  (addressed│unchanged│
│   │ You said                                           │   │   repeated│unknown)
│   │ │ quoted selected text                             │   │ .lsr-replay-quote
│   │ comment text                                       │   │
│   │                                                    │   │
│   │ The agent's answer                                 │   │ .lsr-replay-answer
│   │ note text                                          │   │
│   │                                                    │   │
│   │ What changed                                       │   │ .lsr-replay-changes
│   │ (per-file diff │ "no change" │ unrecorded note)    │   │
│   └────────────────────────────────────────────────────┘   │
│   [Previous]          ● ● ○ ○              [Next / Done]   │ .lsr-replay-nav + -dots
│                   Skip to the diff                         │ .lsr-replay-skip
└────────────────────────────────────────────────────────────┘
```

## 10. Ended overlay — closing summary (status-banner.ts)

Topmost (z20). Scrim over the still-visible diff, one summary card.

```
┌ .lsr-ended-overlay (scrim, z20) ───────────────────┐
│       ┌ section.lsr-closing ─────────────────┐     │
│       │ END OF REVIEW                        │     │ .lsr-closing-eyebrow
│       │ 3 of 5 files approved.               │     │ .lsr-closing-verdict
│       │                                      │     │
│       │  2        3        5       180       │     │ .lsr-closing-figures
│       │ rounds  chapters  files  lines       │     │ (count over label,
│       │              4         1             │     │  zero figures dropped)
│       │        comments sent  replies        │     │
│       │                                      │     │
│       │ You ended this review. You can       │     │ .lsr-closing-note
│       │ close this tab.                      │     │
│       └──────────────────────────────────────┘     │
└────────────────────────────────────────────────────┘
```

## 11. Design-system constraints (hard rules, guard-tested)

`test/browser/chrome-css.test.ts` fails the build when these are broken:

- **Color only through tokens.** Color literals (oklch/hex/rgb/hsl) exist
  solely in `--lsr-*` token definitions. Everything else uses `var(…)` or
  `color-mix(…)` of tokens: semantics `--lsr-bg --lsr-surface --lsr-raised
--lsr-border --lsr-selected --lsr-code-quiet --lsr-text --lsr-strong
--lsr-muted --lsr-accent --lsr-on-accent --lsr-shadow-lift --lsr-shadow-flat
--lsr-scrim`, hues `--lsr-green/red/amber/violet/pink/cyan`, diff
  `--lsr-add-bg/tx/hl --lsr-del-bg/tx/hl`.
- **Both schemes at once.** Every color pair is a `light-dark()`; the page
  declares `color-scheme: light dark` and the header switch writes
  `:root[data-color-scheme="light|dark"]`. Never a `prefers-color-scheme`
  media query. Overlays may define local palettes the same way (e.g. the
  opening room's `--lsr-opening-*`).
- **Type only through tokens.** `--lsr-size-code/ui/meta/label/icon/title/
cover/reason`, `--lsr-leading(-tight/-code/-display/-reason)`, `--lsr-font`.
  No literal `font-size`/`line-height` values.
- **Spacing** only `var(--lsr-space-1|2|3|4|6|8|12)`, `0`, or `auto`.
- **Motion:** every animation/transition needs a
  `@media (prefers-reduced-motion: reduce)` counterpart.
- **Structure:** `<body>` children with a class must be grid regions;
  overlay mount points stay classless ids. The layout in these frames is the
  contract — recolor, resurface, retype; do not move boxes.
