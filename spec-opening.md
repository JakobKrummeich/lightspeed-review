# The Opening

What a reviewer meets before the review itself: the round handed over one
reason at a time, as something worth opening rather than a screen that is
simply there.

## Why

A review is somebody handing over work they built. Dropping straight into the
review states the facts and loses the occasion — and, more practically, an intent
list of eight lines shown all at once is read by nobody. One reason on screen,
with nothing else on it, is read.

The cost of the ceremony is presses, so it is spent where it buys the most:
the first round of a review, once, and never again.

## What it is

A room rather than a card: an opaque, full-bleed field over the whole page,
with one sheet standing in the middle of it. There is no scrim and nothing
shows through — until the last press the review is not on screen at all, so
there is nothing to look at instead of the reason being read.

- **The cover.** Where it came from and one loud line: "from your agent" /
  "Something was built for you". One button opens the stack. It does not
  count the reasons: the dots say how many, and a count was one more line to
  read before the first reason could be.
- **One sheet per intent.** In the order the intents were given, each carrying
  one intent and the button, and nothing else at all. The button moves to the
  next; on the last reason it reads **Show the chapters**.
- **The constellation sheet.** Last, and with no words on it at all: the
  round's files, which drifted behind the reasons as stars, gather into one
  constellation per chapter, and the chapter names come up under their
  figures; a long name wraps onto a second line rather than being cut. Its
  button, **Open the review**, is held back until the names have
  been up for 1.5 s — the sheet takes the caret meanwhile, so `Esc` still
  works. A screen reader hears every chapter name in the sheet's
  `aria-label` ("3 chapters: …"); the names on screen are eye-only.

The reason is set nearly as large as the cover's headline and no wider than a
sentence: the size is what stops it being skimmed. The opening is the one
screen in the product with no code on it, which is what buys it a type scale
louder than the rest of the page's.

Each press swaps the sheet on top for the one below: they cross in the middle
of the room, what is coming rising from below and what is done lifting away
above, both invisible while they travel. A row of dots says how many sheets
there are and how far through them the reviewer is — the count is itself news,
because it says how much was asked for. Which reason of how many is the
section's `aria-label`, so a screen reader hears what the dots show and the
room stays empty.

Nothing else goes inside the reason sheets: no file counts, no line counts, no
chapter names, no commits. The wrapper is about why the work exists; the
constellation sheet then shows its shape — one star per file, one figure and
one name (with its file count) per chapter — and the chapter index says the
rest one press later.

### The sky

`layoutSky` in `src/browser/starfield.ts` is pure and seeded from the chapter
names and file paths, so the same round draws the same sky every time:

- one star per file, at most 600; a star's brightness grows with the log of
  the lines it changed;
- each chapter's stars cluster round a point on an arc (a closer arc for three
  chapters or fewer, a ring past six); the figure is the minimum spanning tree over the chapter's
  seven brightest stars, and the rest of its files stay loose around it;
- a name is placed under its figure and kept clear of the others and of the
  strip the button stands in; the box it is checked in is the whole name, two
  lines of it when it wraps, not a guess at one;
- at most eight names: a chapter whose name would overlap is skipped and the
  next one is asked, so the eight are the first eight that fit, and the rest
  keep their figures unnamed.

When the window is resized the sky is laid out again for the new size (after
the resize has settled for 150 ms), so the figures and names stay inside the
room; a resize during the jump is ignored.

The light scheme draws it as a star atlas — ink cores in a thin accent wash on
the paper; the dark one as a night sky — white cores in a wide glow.

## What a press feels like

The ceremony costs presses, so every press pays something back:

- **The flare.** The room takes a hit for 160ms on every press — short enough
  to read as a strike rather than a glow, and gone before the arriving sheet
  has settled.
- **The drift.** The round's files drift as faint stars behind the reasons the
  whole time and twinkle, so the room is alive between presses without
  anything moving over a word. Where each star is comes from `layoutSky`, never
  from `Math.random`.
- **The gathering.** When the constellation sheet arrives the stars travel to
  their places (1.7 s), the figure lines fade in, and the names follow at
  2.4 s.
- **The landing.** The words of the arriving sheet come in from just below, a
  beat behind the sheet carrying them.
- **The button.** It breathes on its own, lifts to meet the pointer, and
  squashes under the press.
- **The jump.** The last press sends the reviewer into hyperspace: the names
  go, every star streaks outward from where it stands with deep stars around
  them so even a one-file review fills the screen, the edges close in, and at
  800 ms a flash covers the swap. The review is underneath when it fades, a
  second after the press.

### Later rounds: the jump alone

Rounds 2 and later have no opening, but they arrive the same way: when the
replay opens on its own for a new round, the same jump plays first — about a
second, no sheets, all deep stars — and the replay overlay opens under the
flash. It is `aria-hidden` and holds the page still while it plays: the page
behind is `inert`, and keys are caught before anything on the page hears them —
`Esc` lands at once, nothing typed reaches a text box, and a hand reopen of the
replay mid-jump is ignored. The caret goes back where it was, without
scrolling, before the replay opens. Reopening the replay by hand, or a round
with no comments to replay, gets no jump.

If a later round arrives while a first round's opening is still up, the jump
closes the opening properly first — its timers, frames and listeners stopped,
the page released — and takes the room over.

### Both schemes

The room is painted twice from one set of rules, because the reviewer can pick
a scheme by hand on top of whatever the machine asked for — so everything goes
through `light-dark()` and nothing through a `prefers-color-scheme` query.

- **Dark — a night sky.** A field darker than the page's own dark, with a beam
  hung over the sheets. Stars are white cores in a wide accent glow, the jump's
  edges deepen into the dark, and the flash is flat and bright.
- **Light — a star atlas.** The paper field, with no coloured light in it at
  all: it darkens toward the edges instead, the way paper does under a lamp.
  Stars are ink cores in a thin accent wash, the jump's edges close in as the
  paper's, and the flash is warm white.

The canvas takes its inks from the page's tokens when it mounts and reads them
again whenever `data-color-scheme` flips, so it follows a scheme picked by hand
mid-opening as the stylesheet does.

The beam and the edge darkening are two layers of the same gradient, always
both painted, each transparent in the scheme it is not for. The flare is
opacity on one flash layer rather than a filter, because a filter value cannot
be switched between schemes the way a colour can.

### Less motion

A reviewer who asked for less movement gets the whole handover without any of
it: the sheet on top is simply replaced by the one under it, and nothing rises,
flares, breathes or jumps. The sky is drawn once, still, with the figures
already formed; the names come up with them and the button after the same
1.5 s look. The last press lands at once, with no jump and no flash — a
quarter-second of white across the screen is worse than no reward at all. A
later round lands on its replay at once too.

Under forced colours the canvas is hidden and never drawn into: the names
stand alone on the system background, and nothing jumps.

## When it opens

All of these, or it does not open at all:

- the review is on its **first round** (`currentRound(rounds) === 0`);
- that round states **at least one intent**;
- the review has **not ended**;
- this browser has not already opened it for this review.

Later rounds keep the between-rounds replay overlay they have today, so the two
never stack: the replay answers "what became of my comments", which a first
round has none of.

## What it never does

- It never withholds the review. `Esc` closes it at any sheet and lands on the
  home screen, and closing counts as opened: it does not come back.
- It never appears twice. The flag is written the moment it opens, so a reload
  mid-stack lands on the home screen rather than starting the ceremony again.
- It never shows a sheet the round did not state. A round opened without an
  intent has nothing to unwrap and gets no overlay.
- It never lets the page behind it be reached. While it is up every other
  child of `body` is `inert` (released on close), sheets not on top are
  `inert` too, so `Tab` only ever finds the top sheet's button.
- It never scrolls. The room clips instead of scrolling, and focus moves with
  `preventScroll`, so a long reason on a short screen cannot drag the sky or
  the flash off centre.

## How it is built

- `renderOpening(intents, chapters)` in `src/browser/opening-view.ts` — pure,
  one HTML string for the whole room, no DOM: the sky's canvas, tunnel and
  names layer, every sheet (the constellation sheet only when there are
  chapters), the dots and the flash layer. `renderSkyNames` draws the names at
  the places `layoutSky` gave them. Every sheet is in the markup from the start; peeling
  moves a `data-at` attribute (`gone` / `top` / `under`), so a press is one
  attribute write and the animation is the stylesheet's business.
- `mountOpening` in `src/browser/dom/opening-overlay.ts` — the mount, modelled
  on `mountReplayOverlay`: `Escape` closes, focus moves to the top sheet's
  button on every peel and is restored to the page on close. It also writes the
  lights — `data-flare` on every press, `data-sky` when the constellation
  sheet arrives, `data-jump` and `data-bloom` on the last press — and ignores
  anything pressed once the jump has started. The flare's timer is tracked and
  cleared on close. `holdPageBehind` in `src/browser/dom/page-hold.ts` makes
  the rest of the page `inert` while the room is up.
- `mountOpeningSky` in `src/browser/dom/opening-sky.ts` — what the room does
  meanwhile: lays out the sky, starts the painter, and runs the gathering, the
  names, the held button and the jump on timers (`SKY_TIMES`), never on a frame
  or an `animationend`, so every step comes on time whether or not anything was
  painted. `stop()` leaves no timer and no animation frame behind.
- `paintSky` in `src/browser/dom/starfield-canvas.ts` — the only canvas code in
  the page. Every star is one `drawImage` of a sprite rendered once, the
  figures are one path, and the jump strokes three batched paths a frame
  (`src/browser/warp-field.ts`), inside a 4 ms frame at 600 stars, reusing
  its arrays so a frame makes next to no garbage.
- `playJump` in `src/browser/dom/jump-overlay.ts` — the later rounds' jump,
  drawn into `#lsr-opening`, called from the replay's automatic open. Both
  the opening and the jump claim that root through
  `src/browser/dom/room-claim.ts`: a claim evicts whoever holds it (running
  their close), so a round that arrives under a live opening closes it first.
- `stillness()` in `src/browser/dom/stillness.ts` reads
  `prefers-reduced-motion` and `forced-colors` on every call, never cached:
  either can change under an open page.
- The room's colours are locals on `.lsr-opening-overlay` rather than page
  tokens (`--lsr-opening-room`, `-lamp`, `-halo`, `-edge`, `-pool`,
  `-tunnel`, `-flash`, `-bloom-core`, `-bloom-edge`), shared with
  `.lsr-jump-overlay`: nothing else on the page is in this room.
- `#lsr-opening` in `src/html-template.ts`, beside `#lsr-replay`. The opening
  sits at the replay's overlay layer (z-index 18); the jump overlay sits above
  it at z-index 20, so the replay opening under its flash stays hidden until
  the flash fades.
- `unwrapped` on `ReviewMemory` — a plain flag, like `replayed`, untouched by
  the round-change reset.
- The sheets' motion is CSS transitions and keyframes; the sky's is the
  canvas loop. `prefers-reduced-motion: reduce` turns both off: the reveal is
  then a swap, which says the same thing without moving.
