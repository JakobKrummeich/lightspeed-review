/**
 * The opening's sky: files drift as stars behind the reasons, gather into one
 * constellation per chapter on the last sheet, and jump into the review at
 * the last press. `opening-overlay.ts` owns the sheets.
 *
 * Every step is on a timer, never on a frame or an `animationend`, so the
 * names, the button and the landing come on time even when nothing is
 * painted (reduced motion, forced colours, no canvas).
 */
import { renderSkyNames } from "../opening-view.ts";
import {
  SKY_TIMES,
  estimateName,
  layoutSky,
  type MeasureName,
  type SkyBox,
  type SkyChapter,
} from "../starfield.ts";
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

/** A drag-resize is a burst of events: the sky is laid out again once it settles. */
const RESIZE_SETTLE_MS = 150;

/** The room is fixed and full-bleed, so the window is its size. */
function viewOf(): { view: SkyBox; box: SkyBox } {
  const view = { width: window.innerWidth, height: window.innerHeight };
  return { view, box: view };
}

/**
 * Calls `changed` once a burst of resizes settles, or when the pixel density
 * moves (a drag to another screen fires no resize). Returns the unsubscribe.
 */
function onSettledResize(changed: () => void): () => void {
  let settle: ReturnType<typeof setTimeout> | undefined;
  const onResize = (): void => {
    clearTimeout(settle);
    settle = setTimeout(changed, RESIZE_SETTLE_MS);
  };
  window.addEventListener("resize", onResize);
  const unwatchDensity = onDensityChange(onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    unwatchDensity();
    clearTimeout(settle);
  };
}

/**
 * A resolution query only says when the density leaves the one it names, so
 * each change re-arms the watch at the new density.
 */
function onDensityChange(changed: () => void): () => void {
  const now = (): MediaQueryList =>
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  let query = now();
  const onChange = (): void => {
    query.removeEventListener("change", onChange);
    query = now();
    query.addEventListener("change", onChange);
    changed();
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Names measured in the font a probe title computes to. The font is set on
 * every ask because a resize resets the context's. Falls back to the estimate
 * with no 2D context.
 */
function measureNames(field: HTMLElement, names: HTMLElement | null): MeasureName {
  const canvas = field.querySelector<HTMLCanvasElement>(".lsr-sky-canvas");
  const context =
    canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!context || !names) return estimateName;
  names.innerHTML = '<span class="lsr-sky-name"><span class="lsr-sky-title">M</span></span>';
  // Just written, so there. Read before the probe goes: a computed style is
  // live, and empty once detached.
  const font = fontOf(getComputedStyle(names.querySelector<HTMLElement>(".lsr-sky-title")!));
  names.innerHTML = "";
  return (text) => {
    context.font = font;
    return context.measureText(text).width;
  };
}

function fontOf(style: CSSStyleDeclaration): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

export function mountOpeningSky(
  field: HTMLElement,
  chapters: readonly SkyChapter[],
  still: Stillness,
  paint: typeof paintSky = paintSky,
): OpeningSky {
  const { view, box } = viewOf();
  const names = field.querySelector<HTMLElement>(".lsr-sky-names");
  const measure = measureNames(field, names);
  const sky = layoutSky(chapters, box, measure);
  const canvas = field.querySelector<HTMLCanvasElement>(".lsr-sky-canvas");
  // Forced colours paint no decoration: the stylesheet hides the canvas, and
  // nothing is drawn into it either.
  const painter =
    canvas === null || still.forcedColors
      ? undefined
      : paint(canvas, sky, view, still.reducedMotion);
  const moving = !still.reducedMotion && !still.forcedColors;
  if (names) names.innerHTML = renderSkyNames(sky.labels);
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, run: () => void): void => {
    timers.push(setTimeout(run, ms));
  };
  const unwatch = onSettledResize(() => {
    const next = viewOf();
    const laid = layoutSky(chapters, next.box, measure);
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
