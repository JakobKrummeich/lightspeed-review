/**
 * The opening's sky (07 Constellations, 08 Hyperspace): the files drift as
 * stars while the reasons are read, gather into one constellation per chapter
 * when the last sheet arrives, take their names, and at the last press jump
 * the reviewer into the review. `opening-overlay.ts` owns the sheets and when
 * each of these happens; this owns what the room does meanwhile.
 *
 * Every step is on a timer, never on a frame or an `animationend`: the names,
 * the button and the landing come on the same clock whether or not anything
 * was painted — under reduced motion, forced colours, or with no canvas. A
 * resize lays the sky out again once the window settles, until the jump.
 */
import { renderSkyNames } from "../opening-view.ts";
import { SKY_TIMES, layoutSky, type SkyBox, type SkyChapter } from "../starfield.ts";
import { paintSky } from "./starfield-canvas.ts";
import type { Stillness } from "./stillness.ts";

export interface OpeningSky {
  /** The constellation sheet is up: gather, name the chapters, then `reveal` the way on. */
  arrive(reveal: () => void): void;
  /** The last press: jump, flash over the swap, then `land`. At once when still. */
  leave(land: () => void): void;
  /** Esc or landing: no timer and no animation frame outlives the room. */
  stop(): void;
}

/** The strip under the sky kept clear for the button, px. */
const BUTTON_BAND = 128;
/** A drag-resize is a burst of events: the sky is laid out again once it settles. */
const RESIZE_SETTLE_MS = 150;

/**
 * The room is fixed and full-bleed, so the window is its size. The stars keep
 * off the strip the sky sheet's button stands in.
 */
function viewOf(): { view: SkyBox; box: SkyBox } {
  const view = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
  return {
    view,
    box: { width: view.width, height: Math.max(view.height / 2, view.height - BUTTON_BAND) },
  };
}

/** Calls `changed` once a burst of resizes settles; what it returns stops listening. */
function onSettledResize(changed: () => void): () => void {
  let settle: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    clearTimeout(settle);
    settle = setTimeout(changed, RESIZE_SETTLE_MS);
  };
  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    clearTimeout(settle);
  };
}

export function mountOpeningSky(
  field: HTMLElement,
  chapters: readonly SkyChapter[],
  still: Stillness,
  paint: typeof paintSky = paintSky,
): OpeningSky {
  const { view, box } = viewOf();
  const sky = layoutSky(chapters, box);
  const canvas = field.querySelector<HTMLCanvasElement>(".lsr-sky-canvas");
  // Forced colours paint no decoration: the stylesheet hides the canvas, and
  // nothing is drawn into it either.
  const painter =
    canvas === null || still.forcedColors
      ? undefined
      : paint(canvas, sky, view, still.reducedMotion);
  const moving = !still.reducedMotion && !still.forcedColors;
  const names = field.querySelector<HTMLElement>(".lsr-sky-names");
  if (names) names.innerHTML = renderSkyNames(sky.labels);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, run: () => void): void => {
    timers.push(setTimeout(run, ms));
  };
  // The window changed under the room (a resize, a zoom, a move to a screen
  // of another density): the layout, the canvas and the names all again.
  const unwatch = onSettledResize(() => {
    const next = viewOf();
    const laid = layoutSky(chapters, next.box);
    painter?.resize(laid, next.view);
    if (names) names.innerHTML = renderSkyNames(laid.labels);
  });

  return {
    arrive(reveal) {
      field.dataset.sky = "true";
      painter?.gather();
      // Still, the figures are already formed: the names with them, and the
      // button after the same look at them.
      const namesAt = moving ? SKY_TIMES.namesAtMs : 0;
      later(namesAt, () => {
        if (names) names.dataset.on = "true";
      });
      later(namesAt + SKY_TIMES.heldAfterNamesMs, reveal);
    },
    leave(land) {
      unwatch();
      if (!moving) return land();
      if (names) names.dataset.on = "false";
      field.dataset.jump = "true";
      painter?.jump();
      later(SKY_TIMES.flashAtMs, () => {
        field.dataset.bloom = "true";
      });
      later(SKY_TIMES.jumpMs, land);
    },
    stop() {
      painter?.stop();
      unwatch();
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
