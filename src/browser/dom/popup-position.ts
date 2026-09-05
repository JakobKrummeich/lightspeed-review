/**
 * Where the annotation popup goes. Split from the mount because it is
 * arithmetic, not DOM: off-screen popups are preventable by a table of numbers.
 */

/** Between the selection and the popup, so the marked code stays readable. */
const GAP = 8;

/**
 * Least distance from a screen edge. Mirrors the stylesheet's
 * `calc(100vh - 8px)` cap on `.lsr-popup`, so an over-tall popup is already
 * placeable against the top edge.
 */
const EDGE = 8;

export interface PopupPlacementInput {
  /**
   * Selection rect in screen coordinates (`getBoundingClientRect`). Edges can
   * be negative: an upward autoscrolling drag leaves it above the screen.
   */
  selection: { top: number; bottom: number; left: number };
  /** The popup's size as rendered, after the stylesheet has capped it. */
  popup: { width: number; height: number };
  /** The visible area, in the same screen coordinates as `selection`. */
  viewport: { width: number; height: number };
  /**
   * Document scroll offset. Always zero on this page (the diff scrolls inside
   * itself), so defence, not correction: the popup is absolute in page
   * coordinates, and a future document scroll must not require a rewrite.
   */
  scroll: { x: number; y: number };
}

/** The popup's own corner, in page coordinates, ready for `style.top`/`left`. */
export interface PopupPlacement {
  top: number;
  left: number;
}

/**
 * Fit decided against the screen; scroll added once at the end. Comparing page
 * coordinates with viewport height would make a scrolled page look roomless.
 */
export function popupPosition(input: PopupPlacementInput): PopupPlacement {
  return {
    top: fitVertically(input) + input.scroll.y,
    left: fitHorizontally(input) + input.scroll.x,
  };
}

/** Below the selection if it fits, above it if that does, the bottom edge otherwise. */
function fitVertically({ selection, popup, viewport }: PopupPlacementInput): number {
  // Floored before measuring: a selection above the screen has room under it
  // by arithmetic alone, where nobody could see the popup.
  const below = Math.max(EDGE, selection.bottom + GAP);
  if (below + popup.height <= viewport.height - EDGE) return below;
  const above = selection.top - GAP - popup.height;
  if (above >= EDGE) return above;
  // No room either side: cover some selection, pushed off the bottom edge but
  // never past the top — an over-tall popup hangs from the top on its own scroll.
  return Math.max(EDGE, viewport.height - EDGE - popup.height);
}

/**
 * Selection's left edge, clamped on screen. Left, not reading-order start: the
 * page is `lang="en"` with no `dir`, and RTL would only anchor at the wrong
 * end — still on screen.
 */
function fitHorizontally({ selection, popup, viewport }: PopupPlacementInput): number {
  return Math.max(EDGE, Math.min(selection.left, viewport.width - EDGE - popup.width));
}
