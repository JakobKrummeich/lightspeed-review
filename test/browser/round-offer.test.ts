import { test } from "node:test";
import assert from "node:assert/strict";
import {
  holdsRound,
  renderRoundPopup,
  roundOfferLabel,
  type ReviewerPlace,
} from "../../src/browser/round-offer.ts";
import { NOTHING_QUEUED, type QueueTally } from "../../src/browser/queued-pill.ts";

function place(over: Partial<ReviewerPlace> = {}): ReviewerPlace {
  return { scrolled: 0, queued: NOTHING_QUEUED, focus: undefined, ...over };
}

function tally(over: Partial<QueueTally>): QueueTally {
  return { ...NOTHING_QUEUED, ...over };
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
  assert.equal(holdsRound(place({ queued: tally({ comments: 1 }) })), true);
  assert.equal(holdsRound(place({ queued: tally({ resolves: 1 }) })), true);
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

/**
 * Nothing in the page has ever dropped a queued pill on a new round, but a
 * reviewer holding six unsent comments cannot know that — and the cost of
 * guessing wrong is pressing "keep reading" on a round they wanted.
 */
test("the offer says the reviewer's unsent comments are kept", () => {
  assert.equal(
    roundOfferLabel(1, 4, tally({ comments: 2 })),
    "Round 2 is ready · 4 files · 2 comments kept",
  );
  assert.equal(
    roundOfferLabel(1, 4, tally({ comments: 1 })),
    "Round 2 is ready · 4 files · 1 comment kept",
  );
});

test("an empty queue is not mentioned: there is nothing to reassure anyone about", () => {
  assert.equal(roundOfferLabel(1, 4, NOTHING_QUEUED), "Round 2 is ready · 4 files");
  assert.equal(roundOfferLabel(1, 4), "Round 2 is ready · 4 files");
});

test("the card spells out what the header only counts", () => {
  const html = renderRoundPopup(1, 4, tally({ comments: 2 }));

  assert.match(
    html,
    /<p class="lsr-round-queue">Your 2 comments stay queued — they go out on your next Send\.<\/p>/,
  );
  assert.match(html, /aria-label="Round 2 is ready · 4 files · 2 comments kept"/);
});

test("a card with nothing queued behind it makes no promise about a queue", () => {
  assert.doesNotMatch(renderRoundPopup(1, 4, NOTHING_QUEUED), /lsr-round-queue/);
});

test("one queued thing is spoken of in the singular", () => {
  assert.match(
    renderRoundPopup(1, 4, tally({ comments: 1 })),
    /Your 1 comment stays queued — it goes out on your next Send\./,
  );
});

test("replies and resolves are counted as what they are, not as comments", () => {
  assert.equal(
    roundOfferLabel(1, 4, tally({ replies: 1 })),
    "Round 2 is ready · 4 files · 1 reply kept",
  );
  assert.match(
    renderRoundPopup(1, 4, tally({ replies: 1 })),
    /Your 1 reply stays queued — it goes out on your next Send\./,
  );
  assert.equal(
    roundOfferLabel(1, 4, tally({ comments: 2, replies: 3, resolves: 1 })),
    "Round 2 is ready · 4 files · 2 comments, 3 replies and 1 resolve kept",
  );
  assert.match(
    renderRoundPopup(1, 4, tally({ comments: 1, resolves: 2 })),
    /Your 1 comment and 2 resolves stay queued — they go out on your next Send\./,
  );
});
