import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anchoredScrollTop,
  foldHeight,
  foldProgress,
  FOLD_DURATION_MS,
  type ScrollAnchor,
} from "../../src/browser/scroll-anchor.ts";

/** A fold of something the reviewer can see, which is the case that must not move. */
function visible(anchor: Partial<ScrollAnchor>): ScrollAnchor {
  return {
    scrollTop: 4000,
    beforeTop: 300,
    afterTop: 300,
    progress: 1,
    ...anchor,
  };
}

test("a fold that moved nothing asks for the offset the scroller already has", () => {
  assert.equal(anchoredScrollTop(visible({})), 4000);
});

test("the offset pays for the height that vanished above the anchor", () => {
  // The collapse dragged the anchor from 300px to 100: the lost 200px must come out of the offset.
  assert.equal(anchoredScrollTop(visible({ afterTop: 100 })), 3800);
});

test("an anchor pushed down by an expansion is paid for the same way", () => {
  assert.equal(anchoredScrollTop(visible({ afterTop: 460 })), 4160);
});

test("the correction is a fixed point, so a frame that is already right changes nothing", () => {
  // Applied every frame of a fold, it must not compound: whatever it corrected
  // last frame is where the anchor now is.
  const held = anchoredScrollTop(visible({ afterTop: 100 }));

  assert.equal(anchoredScrollTop(visible({ scrollTop: held, afterTop: 300 })), held);
});

test("no offset is ever negative, however much height a fold near the top gave back", () => {
  // A browser would clamp this anyway; clamping it here is what makes it a
  // thing the review can be sure of rather than a thing it hopes for.
  assert.equal(anchoredScrollTop(visible({ scrollTop: 40, beforeTop: 900, afterTop: 300 })), 0);
});

test("an anchor off the top of the screen is held there unless the walk is asked for", () => {
  // The case the rule turns on: holding never travels, however far up the anchor;
  // only a caller that says `walkTo` gets a scroll.
  const offScreen = { scrollTop: 4000, beforeTop: -940, afterTop: -940 };

  assert.equal(anchoredScrollTop({ ...offScreen, progress: 0 }), 4000);
  assert.equal(anchoredScrollTop({ ...offScreen, progress: 0.5 }), 4000);
  assert.equal(anchoredScrollTop({ ...offScreen, progress: 1 }), 4000);
});

test("the walk brings an off-screen anchor onto the top edge over the fold", () => {
  // Last tick of a group: the header is far off-screen and nothing else survives, so it walks
  // to the edge — half way there half way through the fold.
  const offScreen = { scrollTop: 4000, beforeTop: -940, afterTop: -940, walkTo: 60 };

  assert.equal(anchoredScrollTop({ ...offScreen, progress: 0 }), 4000);
  assert.equal(anchoredScrollTop({ ...offScreen, progress: 0.5 }), 3500);
  assert.equal(anchoredScrollTop({ ...offScreen, progress: 1 }), 3000);
});

test("an anchor at or below the top edge is held even where a walk was allowed", () => {
  const atEdge = { scrollTop: 4000, beforeTop: 60, afterTop: 60, walkTo: 60, progress: 0.5 };

  assert.equal(anchoredScrollTop(atEdge), 4000);
  assert.equal(anchoredScrollTop({ ...atEdge, beforeTop: 500, afterTop: 500 }), 4000);
});

test("progress runs from nothing to everything, eased and clamped at both ends", () => {
  assert.equal(foldProgress(0), 0);
  assert.equal(foldProgress(FOLD_DURATION_MS), 1);
  // A frame that arrived late must not carry the fold past its own height.
  assert.equal(foldProgress(FOLD_DURATION_MS * 3), 1);
  assert.equal(foldProgress(-5), 0);
  // Eased out: over half the movement is done in the first half of the time.
  assert.ok(foldProgress(FOLD_DURATION_MS / 2) > 0.5);
});

test("a fold with no duration is simply over", () => {
  assert.equal(foldProgress(0, 0), 1);
});

test("the height walks from where it started to where it is going", () => {
  assert.equal(foldHeight(800, 0, 0), 800);
  assert.equal(foldHeight(800, 0, 0.25), 600);
  assert.equal(foldHeight(0, 800, 1), 800);
  // Nothing outside the two ends, whatever a caller hands in.
  assert.equal(foldHeight(800, 0, 2), 0);
  assert.equal(foldHeight(800, 0, -1), 800);
});
