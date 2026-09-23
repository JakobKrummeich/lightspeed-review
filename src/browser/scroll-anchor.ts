/**
 * Hold the pressed element at its viewport position and pay the vanished
 * height out of the scroll offset, so a tick at the end of a long diff does not
 * teleport the reviewer. Pure on purpose — the pixel-wrong part, testable; DOM
 * plumbing is in `dom/fold.ts`.
 */

export interface ScrollAnchor {
  scrollTop: number;
  /** Viewport top before the fold began. */
  beforeTop: number;
  /** Viewport top after this frame's height change. */
  afterTop: number;
  /**
   * Scroller's top edge, set only when the anchor may be off screen — then it
   * is a destination, not an anchor: see `restingTop`.
   */
  walkTo?: number;
  /** 0 at the first frame, 1 when the fold is over. */
  progress: number;
}

/**
 * Self-correcting per frame: the fixed point is the anchor at `restingTop`, so
 * drift is pulled back, not compounded. Never negative: browsers clamp anyway
 * — better said here, where it can be tested.
 */
export function anchoredScrollTop(anchor: ScrollAnchor): number {
  const resting = restingTop(anchor);
  return Math.max(0, anchor.scrollTop + anchor.afterTop - resting);
}

/**
 * `walkTo` is a deliberate scroll, not an anchoring — a group-closing tick
 * hides everything holdable, so the caller passes the scroller's top edge and
 * an above-screen anchor walks down onto it over `progress`, reading as one
 * movement. An anchor at or below the edge is held even then.
 */
function restingTop(anchor: ScrollAnchor): number {
  const { beforeTop, walkTo, progress } = anchor;
  if (walkTo === undefined || beforeTop >= walkTo) return beforeTop;
  return beforeTop + (walkTo - beforeTop) * clamp(progress);
}

/** Long enough for the eye to follow, short enough not to be waited on. */
export const FOLD_DURATION_MS = 160;

/**
 * Eased out: most height goes early, one gesture settling. Clamped both ends —
 * late frames must not overshoot into a bounce.
 */
export function foldProgress(elapsedMs: number, durationMs = FOLD_DURATION_MS): number {
  if (durationMs <= 0) return 1;
  const linear = clamp(elapsedMs / durationMs);
  return 1 - (1 - linear) ** 3;
}

export function foldHeight(from: number, to: number, progress: number): number {
  return from + (to - from) * clamp(progress);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}
