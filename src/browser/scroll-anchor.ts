/**
 * Arithmetic behind an anchored collapse: hold the pressed element at its
 * viewport position and pay the vanished height out of the scroll offset,
 * so a tick at the end of a long diff does not teleport the reviewer. Pure on
 * purpose — the pixel-wrong part, testable; DOM plumbing is in `dom/fold.ts`.
 */

/** One reading of where the anchor is, against where it was. */
export interface ScrollAnchor {
  /** Where the scrolling element stands at this instant. */
  scrollTop: number;
  /** The anchor's viewport top as it was before the fold began. */
  beforeTop: number;
  /** Its viewport top now, after this frame's height change. */
  afterTop: number;
  /**
   * Scroller's top edge, set only when the anchor may be off screen — then it
   * is a destination, not an anchor: see `restingTop`.
   */
  walkTo?: number;
  /** How far the fold has run, 0 at the first frame and 1 when it is over. */
  progress: number;
}

/**
 * Where the scroller must stand for the anchor to sit right. Self-correcting
 * per frame: the fixed point is the anchor at `restingTop`, so drift is pulled
 * back, not compounded. Never negative: browsers clamp anyway — better said
 * here, where it can be tested.
 */
export function anchoredScrollTop(anchor: ScrollAnchor): number {
  const resting = restingTop(anchor);
  return Math.max(0, anchor.scrollTop + anchor.afterTop - resting);
}

/**
 * Where the anchor ends up: almost always exactly where it was. `walkTo` is
 * the exception and is a deliberate scroll, not an anchoring — a group-closing
 * tick hides everything holdable, so the caller passes the scroller's top
 * edge and an above-screen anchor walks down onto it over `progress`, reading
 * as one movement. An anchor at or below the edge is held even then.
 */
function restingTop(anchor: ScrollAnchor): number {
  const { beforeTop, walkTo, progress } = anchor;
  if (walkTo === undefined || beforeTop >= walkTo) return beforeTop;
  return beforeTop + (walkTo - beforeTop) * clamp(progress);
}

/** How long a fold takes. Long enough for the eye to follow, short enough not to be waited on. */
export const FOLD_DURATION_MS = 160;

/**
 * Fold progress, eased out: most height goes early, one gesture settling.
 * Clamped both ends — late frames must not overshoot into a bounce.
 */
export function foldProgress(elapsedMs: number, durationMs = FOLD_DURATION_MS): number {
  if (durationMs <= 0) return 1;
  const linear = clamp(elapsedMs / durationMs);
  return 1 - (1 - linear) ** 3;
}

/** The height a fold stands at, between where it started and where it is going. */
export function foldHeight(from: number, to: number, progress: number): number {
  return from + (to - from) * clamp(progress);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
