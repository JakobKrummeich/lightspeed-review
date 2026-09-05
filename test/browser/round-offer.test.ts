import { test } from "node:test";
import assert from "node:assert/strict";
import {
  holdsRound,
  renderRoundPopup,
  roundOfferLabel,
  type ReviewerPlace,
} from "../../src/browser/round-offer.ts";

/** A reviewer who has just loaded the page and touched nothing. */
function place(over: Partial<ReviewerPlace> = {}): ReviewerPlace {
  return { scrolled: 0, queued: 0, focus: undefined, ...over };
}

test("a reviewer who has not started loses nothing, so the round is not held", () => {
  assert.equal(holdsRound(place()), false);
});

test("scrolled off the top is being somewhere", () => {
  assert.equal(holdsRound(place({ scrolled: 1 })), true);
});

test("reading inside a chapter is being somewhere, however far up it they are", () => {
  // The survey is chapter-less and scrolls from the top: a reviewer who opened
  // group 1 and is at its first line has still chosen where they are.
  assert.equal(holdsRound(place({ focus: 0 })), true);
});

test("words queued about this diff are worth protecting even at the top of it", () => {
  assert.equal(holdsRound(place({ queued: 1 })), true);
});

test("the offer names the round the reviewer would count, not the stored index", () => {
  assert.equal(roundOfferLabel(1, 4), "Round 2 is ready · 4 files");
});

test("one file is one file", () => {
  assert.equal(roundOfferLabel(0, 1), "Round 1 is ready · 1 file");
});

test("the popup says what the offer says, and its presses name the round", () => {
  const html = renderRoundPopup(1, 4);

  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-label="Round 2 is ready · 4 files"/);
  assert.match(html, /<h2 class="lsr-round-title">Round 2 is ready<\/h2>/);
  assert.match(html, /<p class="lsr-round-size">4 files<\/p>/);
  assert.match(html, /class="lsr-primary lsr-round-take">Open round 2</);
  assert.match(html, /class="lsr-secondary lsr-round-stay">Keep reading</);
});

test("the popup counts one file the way the offer does", () => {
  assert.match(renderRoundPopup(0, 1), /<p class="lsr-round-size">1 file<\/p>/);
});
