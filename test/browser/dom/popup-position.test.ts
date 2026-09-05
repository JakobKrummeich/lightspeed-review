import { test } from "node:test";
import assert from "node:assert/strict";
import { popupPosition } from "../../../src/browser/dom/popup-position.ts";

/** A reviewer's screen, and a popup at the 22rem the stylesheet gives it. */
const VIEWPORT = { width: 1000, height: 800 };
const POPUP = { width: 352, height: 300 };
const UNSCROLLED = { x: 0, y: 0 };

test("a selection with room under it wears the popup just below, at its left edge", () => {
  const placed = popupPosition({
    selection: { top: 100, bottom: 120, left: 200 },
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: UNSCROLLED,
  });

  assert.deepEqual(placed, { top: 128, left: 200 });
});

test("a selection near the bottom flips the popup above it, rather than off screen", () => {
  // Below would put the popup's foot — the Queue Feedback button — at 1008px of
  // an 800px screen, which is the bug: the button was barely pressable.
  const placed = popupPosition({
    selection: { top: 600, bottom: 700, left: 200 },
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: UNSCROLLED,
  });

  assert.deepEqual(placed, { top: 292, left: 200 });
  assert.ok(placed.top + POPUP.height <= VIEWPORT.height, "the button is on screen");
});

test("the popup keeps the screen's bottom margin, rather than ending flush against it", () => {
  // The last row that still fits below: 484 + 8 gap + 300 tall = 792, the 800px
  // screen less the 8px margin. One pixel lower is one pixel too far.
  const fits = popupPosition({
    selection: { top: 400, bottom: 484, left: 40 },
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: UNSCROLLED,
  });
  const overshoots = popupPosition({
    selection: { top: 400, bottom: 485, left: 40 },
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: UNSCROLLED,
  });

  assert.equal(fits.top, 492, "still below the selection, with the margin intact");
  assert.equal(overshoots.top, 92, "above it: 400 - 8 - 300");
});

test("a selection dragged off the top of the screen does not take the popup with it", () => {
  // An upward drag autoscrolls, and the selection's rectangle goes negative
  // while the mouse is still down. Below such a selection is above the screen.
  const placed = popupPosition({
    selection: { top: -600, bottom: -500, left: 40 },
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: UNSCROLLED,
  });

  assert.deepEqual(placed, { top: 8, left: 40 });
});

test("a selection with room on neither side sits the popup on the bottom edge", () => {
  // A tall selection on a short screen: above starts off the top, below ends off
  // the bottom, so the popup covers the selection instead of leaving the screen.
  const placed = popupPosition({
    selection: { top: 120, bottom: 200, left: 40 },
    popup: POPUP,
    viewport: { width: 1000, height: 400 },
    scroll: UNSCROLLED,
  });

  assert.deepEqual(placed, { top: 92, left: 40 });
});

test("a popup taller than the screen starts at the top edge, and scrolls inside itself", () => {
  // Nothing can fit it: hung from the top edge, `overflow-y` takes the rest; focusing the box on
  // open brings the controls into that scroll.
  const placed = popupPosition({
    selection: { top: 600, bottom: 700, left: 40 },
    popup: { width: 352, height: 900 },
    viewport: VIEWPORT,
    scroll: UNSCROLLED,
  });

  assert.deepEqual(placed, { top: 8, left: 40 });
});

test("a selection near the right edge pulls the popup back inside it", () => {
  // The panel owns the right 22rem, so this is where the reviewer's selections
  // end: at 900px the popup's own 352px would run 252px past the screen.
  const placed = popupPosition({
    selection: { top: 100, bottom: 120, left: 900 },
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: UNSCROLLED,
  });

  assert.deepEqual(placed, { top: 128, left: 640 });
});

test("a screen narrower than the popup leaves it at the left edge, not past it", () => {
  const placed = popupPosition({
    selection: { top: 100, bottom: 120, left: 90 },
    popup: POPUP,
    viewport: { width: 300, height: 800 },
    scroll: UNSCROLLED,
  });

  assert.deepEqual(placed, { top: 128, left: 8 });
});

test("a scrolled document moves the popup with the page, not with the screen", () => {
  // Today's page never scrolls the document (`body` is 100vh): this holds the defensive half of
  // the arithmetic to its contract.
  const placed = popupPosition({
    selection: { top: 100, bottom: 120, left: 200 },
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: { x: 30, y: 1200 },
  });

  assert.deepEqual(placed, { top: 1328, left: 230 });
});

test("the scroll is not weighed against the screen, which a selection is", () => {
  // Scroll added before the fit would make every selection on a scrolled document look off
  // screen; cheaper to keep right than to find out when the layout changes.
  const onScreen = { top: 600, bottom: 700, left: 200 };

  const unscrolled = popupPosition({
    selection: onScreen,
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: UNSCROLLED,
  });
  const scrolled = popupPosition({
    selection: onScreen,
    popup: POPUP,
    viewport: VIEWPORT,
    scroll: { x: 0, y: 4000 },
  });

  assert.equal(scrolled.top - unscrolled.top, 4000, "the same fit, moved by the scroll");
});
