import { anchoredScrollTop, foldHeight, foldProgress } from "../scroll-anchor.ts";

/**
 * Holds one element at its exact viewport position every frame while blocks
 * fold, so nothing drifts. Anchor rule: hold a landmark that survives the
 * gesture; walk to the top edge (`Anchor.walk`) only where none does — a group
 * fold takes its tick row down with it. Arithmetic lives in
 * `../scroll-anchor.ts`; here is only what a browser can answer.
 */

/** The one scrolling element; a fold is paid out of its offset. */
const SCROLLER = ".lsr-review";

/**
 * Set only while folding; carries just the properties a height animation needs
 * (see stylesheet), so a block at rest is styled as if folding never existed.
 */
const FOLDING_CLASS = "lsr-folding";

/**
 * Tallest block worth animating, in px. A judgement, not a measurement:
 * Chromium frame times (folds of 1129/7489/39819px) tracked the repaint of
 * everything *below* the block, not its own height — so no honest threshold
 * reads off the block. This is just a ceiling past which nobody can follow
 * the fold anyway.
 */
export const MAX_ANIMATED_FOLD_PX = 20000;

export interface Fold {
  content: HTMLElement;
  expanded: boolean;
  animated: boolean;
}

export interface Anchor {
  element: HTMLElement;
  /**
   * May an anchor already above the screen be walked down onto the scroller's
   * top edge? Only a caller that knows nothing on the screen will survive its
   * own gesture asks for this.
   */
  walk: boolean;
}

interface Running {
  content: HTMLElement;
  from: number;
  to: number;
  expanded: boolean;
}

/**
 * Which fold owns each block: a first animation left mid-flight by a quick
 * second tick must not keep writing heights onto a taken-over block.
 */
const owners = new WeakMap<HTMLElement, object>();

/**
 * No anchor (or one outside the scroller): folds still happen, only the
 * correction is skipped.
 */
export function foldAnchored(folds: Fold[], anchor: Anchor | null): void {
  const hold = beginHold(anchor);
  const running = startAll(folds);
  if (running.length === 0) {
    applyHold(hold, 1);
    return;
  }
  animate(running, hold);
}

/** The one-shot fold: no clock, one correction after `change` has moved the page. */
export function anchored<T>(anchor: Anchor | null, change: () => T): T {
  const hold = beginHold(anchor);
  const result = change();
  applyHold(hold, 1);
  return result;
}

function startAll(folds: Fold[]): Running[] {
  const motion = hasFrames() && !reducedMotion();
  // All heights read before any fold is applied: a group measured after its
  // inner file settled would animate from a height already missing that diff.
  const heights = folds.map(startingHeight);
  const running: Running[] = [];
  for (const [index, fold] of folds.entries()) {
    // Started either way: only starting measures the from-height that decides
    // whether it animates.
    const run = start(fold, heights[index] ?? 0);
    if (fold.animated && motion && animates(run)) running.push(run);
    else settle(fold.content, fold.expanded);
  }
  return running;
}

function animate(running: Running[], hold: Hold | undefined): void {
  const owner = {};
  for (const fold of running) owners.set(fold.content, owner);
  const startedAt = performance.now();
  const frame = (): void => {
    const live = running.filter((fold) => owners.get(fold.content) === owner);
    // All blocks taken over: a second writer with a stale `beforeTop` would
    // drag the offset back and forth once a frame.
    if (live.length === 0) return;
    const progress = foldProgress(performance.now() - startedAt);
    for (const fold of live) {
      fold.content.style.height = `${foldHeight(fold.from, fold.to, progress)}px`;
    }
    // After heights are written, before paint: the synchronous layout this
    // rectangle read costs is exactly the layout the correction needs.
    applyHold(hold, progress);
    if (progress < 1) {
      requestAnimationFrame(frame);
      return;
    }
    for (const fold of live) settle(fold.content, fold.expanded);
    // Settling drops inline height and hides what closed: one last page move.
    applyHold(hold, 1);
  };
  requestAnimationFrame(frame);
}

/**
 * Current rendered height, mid-fold included, so an interrupted fold carries
 * on instead of snapping.
 */
function startingHeight(fold: Fold): number {
  return fold.content.hidden ? 0 : fold.content.getBoundingClientRect().height;
}

function start(fold: Fold, from: number): Running {
  const { content, expanded } = fold;
  content.hidden = false;
  content.style.height = "";
  content.classList.add(FOLDING_CLASS);
  const to = expanded ? content.getBoundingClientRect().height : 0;
  content.style.height = `${from}px`;
  return { content, from, to, expanded };
}

function settle(content: HTMLElement, expanded: boolean): void {
  owners.delete(content);
  content.style.height = "";
  content.classList.remove(FOLDING_CLASS);
  content.hidden = !expanded;
}

/** Over the budget, a fold is done at once — and still anchored. */
function animates(run: Running): boolean {
  return Math.max(run.from, run.to) <= MAX_ANIMATED_FOLD_PX;
}

function hasFrames(): boolean {
  return typeof requestAnimationFrame === "function";
}

function reducedMotion(): boolean {
  return globalThis.window?.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
}

interface Hold {
  scroller: HTMLElement;
  anchor: HTMLElement;
  walk: boolean;
  beforeTop: number;
  /** If the scroller no longer stands at the offset last written, the reviewer moved it. */
  wrote: number | undefined;
  released: boolean;
}

function beginHold(anchor: Anchor | null): Hold | undefined {
  const scroller = anchor?.element.closest<HTMLElement>(SCROLLER) ?? null;
  if (!anchor || !scroller) return undefined;
  return {
    scroller,
    anchor: anchor.element,
    walk: anchor.walk,
    beforeTop: anchor.element.getBoundingClientRect().top,
    wrote: undefined,
    released: false,
  };
}

/**
 * A wheel flick mid-fold must win, so each write is read back (browsers clamp
 * past-the-end offsets; a clamp is not a reviewer) and a differing offset next
 * frame releases the hold for good.
 */
function applyHold(hold: Hold | undefined, progress: number): void {
  if (!hold || hold.released) return;
  if (hold.wrote !== undefined && hold.scroller.scrollTop !== hold.wrote) {
    hold.released = true;
    return;
  }
  hold.scroller.scrollTop = anchoredScrollTop({
    scrollTop: hold.scroller.scrollTop,
    beforeTop: hold.beforeTop,
    afterTop: hold.anchor.getBoundingClientRect().top,
    walkTo: hold.walk ? hold.scroller.getBoundingClientRect().top : undefined,
    progress,
  });
  hold.wrote = hold.scroller.scrollTop;
}
