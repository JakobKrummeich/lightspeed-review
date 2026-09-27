/**
 * The painter for the sky (`../starfield.ts`) and the only canvas code in the
 * page. It is decorative: the canvas is `aria-hidden`, and everything it shows
 * is also said in words or not needed at all.
 *
 * Cheap by construction, for the 4 ms-a-frame budget at 600 stars: every star
 * is one `drawImage` of a sprite rendered once, the figure lines are one path,
 * and the jump strokes three batched paths a frame. No per-star `shadowBlur` —
 * that alone cost more than the budget in the prototype. And no garbage of
 * its own a frame: each star keeps one place object, the streaks are written
 * into buffers made once per jump, and every loop is indexed rather than
 * iterated. What a frame still allocates is the engine's: the fractional
 * numbers handed to `drawImage` and `globalAlpha` are boxed on the way into
 * the canvas, about 30 bytes a star.
 */
import {
  SKY_TIMES,
  clamp,
  driftAt,
  figureShown,
  gathered,
  type Sky,
  type SkyBox,
  type Star,
} from "../starfield.ts";
import {
  streakBatches,
  warpField,
  warpSpeed,
  warpStreaks,
  type StreakBatches,
  type WarpField,
} from "../warp-field.ts";

export interface SkyPainter {
  /** The files start gathering into their figures now (formed at once when still). */
  gather(): void;
  /** The stars jump from where they stand now; the loop ends with the jump. */
  jump(): void;
  /** Ends the loop now: nothing is left asking for frames or watching the scheme. */
  stop(): void;
  /**
   * The window changed: `sky` over `view` from now on, from where the clock
   * stands — sized again for the device's pixels. Ignored once jumping.
   */
  resize(sky: Sky, view: SkyBox): void;
}

/** Deep stars around the files, so the jump fills the view however small the review. */
const JUMP_EXTRA = 320;
const SPRITE_RADIUS = 24;

interface Ink {
  accent: string;
  core: string;
  /** Night sky: white cores in a wide glow. Otherwise a star atlas: ink cores in a thin wash. */
  night: boolean;
}

/**
 * The tokens resolved through a probe, because a custom property reads back as
 * its `light-dark()` text, not the colour the page is painting.
 */
function inkOf(canvas: HTMLCanvasElement): Ink {
  const probe = document.createElement("span");
  probe.hidden = true;
  canvas.after(probe);
  const read = (token: string): string => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const ink = {
    accent: read("--lsr-accent"),
    core: read("--lsr-light-ink"),
    night: document.documentElement.dataset.colorScheme === "dark",
  };
  probe.remove();
  return ink;
}

/** One star, drawn once: a white-hot point in a glow at night, an inked dot in a wash on paper. */
function sprite(ink: Ink): HTMLCanvasElement {
  const size = SPRITE_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const r = SPRITE_RADIUS;
  const glow = context.createRadialGradient(r, r, 0, r, r, r);
  const stops: [number, string][] = ink.night
    ? [
        [0, ink.core],
        [0.12, ink.core],
        [0.22, ink.accent],
        [1, "transparent"],
      ]
    : [
        [0, ink.core],
        [0.16, ink.core],
        [0.2, ink.accent],
        [0.32, "transparent"],
        [1, "transparent"],
      ];
  for (const [at, colour] of stops) glow.addColorStop(at, colour);
  context.fillStyle = glow;
  context.fillRect(0, 0, size, size);
  if (!ink.night) {
    context.globalAlpha = 0.14;
    context.fillStyle = ink.accent;
    context.beginPath();
    context.arc(r, r, r * 0.55, 0, Math.PI * 2);
    context.fill();
  }
  return canvas;
}

type StreakStyle = [colour: string, alpha: number, width: number];

interface Scene {
  context: CanvasRenderingContext2D;
  sky: Sky;
  view: SkyBox;
  ink: Ink;
  star: HTMLCanvasElement;
  /** Far, middle, near: worked out once, not per frame. */
  streaks: [StreakStyle, StreakStyle, StreakStyle];
  /** Where each star was last drawn, the jump's starting points. One kept object per star. */
  places: { x: number; y: number }[];
}

/** Each star's place this frame: drifting, or `formed` of the way into its figure. */
function placeStars({ sky, view, places }: Scene, seconds: number, formed: number): void {
  const stars = sky.stars;
  for (let index = 0; index < stars.length; index += 1) {
    const one = stars[index];
    const place = places[index];
    if (one === undefined || place === undefined) continue;
    driftAt(one, seconds, view, place);
    place.x += (one.x - place.x) * formed;
    place.y += (one.y - place.y) * formed;
  }
}

/** `seconds` since the room went up; `ms` since gathering began, or -1 before it. */
function drawSky(scene: Scene, seconds: number, ms: number): void {
  const formed = ms < 0 ? 0 : gathered(ms);
  placeStars(scene, seconds, formed);
  const lines = ms < 0 ? 0 : figureShown(ms);
  if (lines > 0) drawFigures(scene, lines);
  const { stars } = scene.sky;
  for (let index = 0; index < stars.length; index += 1) {
    drawStar(scene, stars[index], scene.places[index], seconds, formed);
  }
  scene.context.globalAlpha = 1;
}

function drawStar(
  { context, ink, star }: Scene,
  one: Star | undefined,
  place: { x: number; y: number } | undefined,
  seconds: number,
  formed: number,
): void {
  if (one === undefined || place === undefined) return;
  const twinkle = 0.6 + 0.4 * Math.sin(one.twinkle + seconds * 4.2);
  const size = 7 + one.magnitude * (ink.night ? 17 : 13) + formed * 3;
  context.globalAlpha = clamp(
    (0.25 + 0.75 * one.magnitude) * Math.max(twinkle, formed * 0.9 + 0.1),
  );
  context.drawImage(star, place.x - size / 2, place.y - size / 2, size, size);
}

function drawFigures({ context, sky, ink, places }: Scene, shown: number): void {
  context.strokeStyle = ink.accent;
  context.lineWidth = 1;
  context.globalAlpha = (ink.night ? 0.7 : 0.55) * shown;
  context.beginPath();
  for (let figure = 0; figure < sky.figures.length; figure += 1) {
    traceEdges(context, sky.figures[figure] ?? [], places);
  }
  context.stroke();
  context.globalAlpha = 1;
}

function traceEdges(
  context: CanvasRenderingContext2D,
  edges: [number, number][],
  places: { x: number; y: number }[],
): void {
  for (let edge = 0; edge < edges.length; edge += 1) {
    const pair = edges[edge] ?? NO_EDGE;
    const from = places[pair[0]];
    const to = places[pair[1]];
    if (!from || !to) continue;
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
  }
}

/** Indexes no star has, so a missing edge draws nothing. */
const NO_EDGE: [number, number] = [-1, -1];

/** Far, middle, near: fainter and thinner far off, the near batch in the core colour. */
function streakStyles(ink: Ink): [StreakStyle, StreakStyle, StreakStyle] {
  return ink.night
    ? [
        [ink.accent, 0.45, 0.8],
        [ink.accent, 0.8, 1.5],
        [ink.core, 1, 2.3],
      ]
    : [
        [ink.accent, 0.4, 1],
        [ink.accent, 0.75, 1.8],
        [ink.core, 0.95, 2.8],
      ];
}

function drawStreaks({ context, streaks }: Scene, batches: StreakBatches): void {
  context.lineCap = "round";
  for (let batch = 0; batch < 3; batch += 1) {
    const end = batches.ends[batch] ?? 0;
    const style = streaks[batch];
    const run = batches.runs[batch];
    if (end === 0 || !style || !run) continue;
    context.strokeStyle = style[0];
    context.globalAlpha = style[1];
    context.lineWidth = style[2];
    context.beginPath();
    tracePath(context, run, end);
    context.stroke();
  }
  context.globalAlpha = 1;
}

/** One sub-path per `x1 y1 x2 y2` run; the nudge gives a standing star a dot, not nothing. */
function tracePath(context: CanvasRenderingContext2D, run: Float32Array, end: number): void {
  for (let at = 0; at < end; at += 4) {
    context.moveTo(run[at] ?? 0, run[at + 1] ?? 0);
    context.lineTo((run[at + 2] ?? 0) + 0.3, (run[at + 3] ?? 0) + 0.3);
  }
}

/** Sized in device pixels and drawn in CSS ones, so a star is as sharp on a 2× screen. */
function sceneOf(canvas: HTMLCanvasElement, sky: Sky, view: SkyBox): Scene | undefined {
  const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!context) return undefined;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(view.width * ratio);
  canvas.height = Math.round(view.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const ink = inkOf(canvas);
  return {
    context,
    sky,
    view,
    ink,
    star: sprite(ink),
    streaks: streakStyles(ink),
    // Doubles from the first write: fields that start as small integers change
    // representation on the first fractional place and throw away the
    // optimised frame code that read them.
    places: sky.stars.map(() => ({ x: Number.NaN, y: Number.NaN })),
  };
}

/** One animation frame at a time, while `step` asks for another and until `stop`. */
function loop(step: (now: number) => boolean): { stop(): void } {
  let frame = 0;
  let stopped = false;
  const tick = (now: number): void => {
    frame = 0;
    if (!stopped && step(now)) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return {
    stop() {
      stopped = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/**
 * Calls `changed` when the page's scheme flips. The scheme toggle writes the
 * effective scheme to `data-color-scheme` — for a pick by hand and for the
 * machine's own change alike — so that one attribute is all there is to watch.
 */
function watchScheme(changed: () => void): () => void {
  if (typeof MutationObserver !== "function") return () => undefined;
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-color-scheme"],
  });
  return () => observer.disconnect();
}

/** The jump in flight: when it began, the last frame, and its field once built. */
interface Flight {
  at: number;
  last: number;
  field?: WarpField;
  batches?: StreakBatches;
}

/** One frame of the jump, from where the stars last stood; false once it is over. */
function flyFrame(scene: Scene, flight: Flight, now: number): boolean {
  const { places, view } = scene;
  flight.field ??= warpField(places, view, "jump", JUMP_EXTRA);
  flight.batches ??= streakBatches(flight.field.z.length);
  const step = warpSpeed(now - flight.at, view) * Math.min(3, (now - flight.last) / 16.7);
  flight.last = now;
  drawStreaks(scene, warpStreaks(flight.field, step, view, flight.batches));
  return now - flight.at < SKY_TIMES.jumpMs;
}

/**
 * Starts painting `sky` over `view` (the whole canvas; the sky's own box may
 * be smaller). Undefined when there is no 2D context — the room goes on
 * without its stars. `still` draws each state once and runs no loop. The inks
 * are read again whenever the scheme flips, and the scene rebuilt on `resize`.
 */
export function paintSky(
  canvas: HTMLCanvasElement,
  sky: Sky,
  view: SkyBox,
  still: boolean,
): SkyPainter | undefined {
  const first = sceneOf(canvas, sky, view);
  if (!first) return undefined;
  let scene = first;
  const started = performance.now();
  let gatherAt: number | undefined;
  let flight: Flight | undefined;
  let stopped = false;

  const draw = (now: number): boolean => {
    scene.context.clearRect(0, 0, scene.view.width, scene.view.height);
    if (flight) return flyFrame(scene, flight, now);
    drawSky(scene, (now - started) / 1000, gatherAt === undefined ? -1 : now - gatherAt);
    return true;
  };
  /** A still sky shows its latest state: drifting, or formed once gathering began. */
  const drawStill = (): void => {
    draw(gatherAt === undefined ? started : gatherAt + SKY_TIMES.namesAtMs);
  };
  const rebuild = (nextSky: Sky, nextView: SkyBox): void => {
    if (stopped) return;
    scene = sceneOf(canvas, nextSky, nextView) ?? scene;
    if (still) drawStill();
  };
  const unwatch = watchScheme(() => rebuild(scene.sky, scene.view));
  const frames = still ? undefined : loop(draw);
  const stop = (): void => {
    stopped = true;
    unwatch();
    frames?.stop();
  };

  if (still) drawStill();
  return {
    gather() {
      gatherAt = performance.now();
      if (still) drawStill();
    },
    jump() {
      if (still) return stop();
      const now = performance.now();
      flight = { at: now, last: now };
    },
    stop,
    resize(nextSky, nextView) {
      if (!flight) rebuild(nextSky, nextView);
    },
  };
}
