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

- **The cover.** Where it came from, one loud line, and how much there is:
  "from your agent" / "Something was built for you" / "Four reasons,
  one at a time." One button opens the stack.
- **One sheet per intent.** In the order the intents were given, each carrying
  one intent and the button, and nothing else at all. The button moves to the
  next; on the last sheet it opens the review.

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

Nothing else goes inside: no file counts, no line counts, no chapter names, no
commits. The chapter index says those things one press later, and the wrapper
is about why the work exists.

## What a press feels like

The ceremony costs presses, so every press pays something back:

- **The flare.** The room takes a hit for 160ms on every press — short enough
  to read as a strike rather than a glow, and gone before the arriving sheet
  has settled.
- **The motes.** Sparse dust drifts up through the light the whole time, so
  the room is alive between presses without anything moving over a word. Where
  each mote is and how long it takes is worked out from its index rather than
  drawn at random: the renderer is pure, and the same round draws the same
  field every time.
- **The landing.** The words of the arriving sheet come in from just below, a
  beat behind the sheet carrying them.
- **The button.** It breathes on its own, lifts to meet the pointer, and
  squashes under the press.
- **The flood.** The last press fills the room with light for 260ms, and the
  review is underneath when it fades.

### Both schemes

The room is painted twice from one set of rules, because the reviewer can pick
a scheme by hand on top of whatever the machine asked for — so everything goes
through `light-dark()` and nothing through a `prefers-color-scheme` query.

- **Dark.** A field darker than the page's own dark, with a gold beam hung over
  the sheets. The flare is a gold bloom, the motes and the button are gold with
  dark ink on them, and the flood is flat cream.
- **Light — ink on paper.** The cream field, with no coloured light in it at
  all: it darkens toward the edges instead, the way paper does under a lamp.
  The accent is blue — the flare a short blue bloom, the motes and the button
  blue with cream on them — and the flood is warm white.

The beam and the edge darkening are two layers of the same gradient, always
both painted, each transparent in the scheme it is not for. The flare is
opacity on one flash layer rather than a filter, because a filter value cannot
be switched between schemes the way a colour can.

### Less motion

A reviewer who asked for less movement gets the whole handover without any of
it: the sheet on top is simply replaced by the one under it, and nothing rises,
flares, breathes or floods. The motes and the flood are hidden outright rather
than left to fade — a quarter-second of white across the screen is worse than
no reward at all.

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

## How it is built

- `renderOpening` in `src/browser/opening-view.ts` — pure, one HTML string for
  the whole room, no DOM: the motes, every sheet, the dots and the layer the
  flood is painted on. Every sheet is in the markup from the start; peeling
  moves a `data-at` attribute (`gone` / `top` / `under`), so a press is one
  attribute write and the animation is the stylesheet's business. `data-sheet`
  says whether a sheet is the cover or a reason, which is how one body rule
  speaks at two sizes.
- `mountOpening` in `src/browser/dom/opening-overlay.ts` — the mount, modelled
  on `mountReplayOverlay`: `Escape` closes, focus moves to the top sheet's
  button on every peel and is restored to the page on close. It also writes the
  two lights — `data-flare` on every press, `data-bloom` on the last one — and
  ignores anything pressed once the flood has started.
- The room's colours are locals on `.lsr-opening-overlay` rather than page
  tokens (`--lsr-opening-field`, `-accent`, `-beam`, `-edge`, `-flash`,
  `-bloom-core`, `-bloom-edge`): nothing else on the page is in this room.
- `#lsr-opening` in `src/html-template.ts`, beside `#lsr-replay`, at the same
  overlay layer (z-index 18).
- `unwrapped` on `ReviewMemory` — a plain flag, like `replayed`, untouched by
  the round-change reset.
- Motion is CSS transitions and keyframes only, and `prefers-reduced-motion:
reduce` turns all of it off: the reveal is then a swap, which says the same
  thing without moving.
