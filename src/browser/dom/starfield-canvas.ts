/**
 * The painter for the sky (`../starfield.ts`). Decorative: the canvas is
 * `aria-hidden`, and what it shows is said in words or not needed.
 *
 * Built for a 4 ms frame at 600 stars: every star is one `drawImage` of a
 * sprite rendered once, the figure lines are one path, and the jump strokes
 * three batched paths a frame. No per-star `shadowBlur`: it alone costs more
 * than the budget. Loops are indexed and places reused, to keep garbage low.
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
import { inkOf, sprite, type Ink } from "./star-sprite.ts";

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

type StreakStyle = [colour: string, alpha: number, width: number];

/** A star and where it was last drawn: one kept object per star, written in place. */
interface Place {
  star: Star;
  x: number;
  y: number;
}

interface Scene {
  context: CanvasRenderingContext2D;
  sky: Sky;
  view: SkyBox;
  ink: Ink;
  sprite: HTMLCanvasElement;
  streaks: [StreakStyle, StreakStyle, StreakStyle];
  places: Place[];
  /** Every figure edge as the two places it joins, looked up once. */
  lines: [Place, Place][];
}

/** Each star's place this frame: drifting, or `formed` of the way into its figure. */
function placeStars({ view, places }: Scene, seconds: number, formed: number): void {
  // Indexed, not `for…of`: an iterator is garbage until the loop is optimised.
  for (let index = 0; index < places.length; index += 1) {
    const place = places[index]!;
    driftAt(place.star, seconds, view, place);
    place.x += (place.star.x - place.x) * formed;
    place.y += (place.star.y - place.y) * formed;
  }
}

/** `seconds` since the room went up; `ms` since gathering began, or -1 before it. */
function drawSky(scene: Scene, seconds: number, ms: number): void {
  const formed = ms < 0 ? 0 : gathered(ms);
  placeStars(scene, seconds, formed);
  const lines = ms < 0 ? 0 : figureShown(ms);
  if (lines > 0) drawFigures(scene, lines);
  for (let index = 0; index < scene.places.length; index += 1) {
    drawStar(scene, scene.places[index]!, seconds, formed);
  }
  scene.context.globalAlpha = 1;
}

function drawStar(
  { context, ink, sprite }: Scene,
  place: Place,
  seconds: number,
  formed: number,
): void {
  const { star } = place;
  const twinkle = 0.6 + 0.4 * Math.sin(star.twinkle + seconds * 4.2);
  const size = 7 + star.magnitude * (ink.night ? 17 : 13) + formed * 3;
  context.globalAlpha = clamp(
    (0.25 + 0.75 * star.magnitude) * Math.max(twinkle, formed * 0.9 + 0.1),
  );
  context.drawImage(sprite, place.x - size / 2, place.y - size / 2, size, size);
}

function drawFigures({ context, ink, lines }: Scene, shown: number): void {
  context.strokeStyle = ink.accent;
  context.lineWidth = 1;
  context.globalAlpha = (ink.night ? 0.7 : 0.55) * shown;
  context.beginPath();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    context.moveTo(line[0].x, line[0].y);
    context.lineTo(line[1].x, line[1].y);
  }
  context.stroke();
  context.globalAlpha = 1;
}

/** The figures' edges as pairs of places; an edge naming a star the sky lacks is left out. */
function figureLines(sky: Sky, places: Place[]): [Place, Place][] {
  return sky.figures.flat().flatMap(([a, b]): [Place, Place][] => {
    const from = places[a];
    const to = places[b];
    return from && to ? [[from, to]] : [];
  });
}

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

function drawStreaks({ context, streaks }: Scene, { runs, ends }: StreakBatches): void {
  context.lineCap = "round";
  strokeBatch(context, streaks[0], runs[0], ends[0]);
  strokeBatch(context, streaks[1], runs[1], ends[1]);
  strokeBatch(context, streaks[2], runs[2], ends[2]);
  context.globalAlpha = 1;
}

/**
 * One path for a batch: a sub-path per `x1 y1 x2 y2` run up to `end`, the
 * nudge giving a standing star a dot rather than nothing.
 */
function strokeBatch(
  context: CanvasRenderingContext2D,
  [colour, alpha, width]: StreakStyle,
  run: Float32Array,
  end: number,
): void {
  if (end === 0) return;
  context.strokeStyle = colour;
  context.globalAlpha = alpha;
  context.lineWidth = width;
  context.beginPath();
  // In bounds by construction: `end` never passes what the batch was written to.
  for (let at = 0; at < end; at += 4) {
    context.moveTo(run[at]!, run[at + 1]!);
    context.lineTo(run[at + 2]! + 0.3, run[at + 3]! + 0.3);
  }
  context.stroke();
}

/**
 * Sized in device pixels and drawn in CSS ones, so a star is as sharp on a 2×
 * screen; the inks read from the page as it is painted now.
 */
function sceneOf(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  sky: Sky,
  view: SkyBox,
): Scene {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(view.width * ratio);
  canvas.height = Math.round(view.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const ink = inkOf(canvas);
  // Doubles from the first write: fields that start as small integers change
  // representation on the first fractional place and throw away the
  // optimised frame code that read them.
  const places = sky.stars.map((star) => ({ star, x: Number.NaN, y: Number.NaN }));
  return {
    context,
    sky,
    view,
    ink,
    sprite: sprite(ink),
    streaks: streakStyles(ink),
    places,
    lines: figureLines(sky, places),
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
 * effective scheme to `data-color-scheme` for both a pick by hand and the
 * machine's own change, so that attribute is all there is to watch.
 */
function watchScheme(changed: () => void): () => void {
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
  const context = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!context) return undefined;
  let scene = sceneOf(canvas, context, sky, view);
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
  const drawStill = (): boolean =>
    draw(gatherAt === undefined ? started : gatherAt + SKY_TIMES.namesAtMs);
  const rebuild = (nextSky: Sky, nextView: SkyBox): void => {
    if (stopped) return;
    scene = sceneOf(canvas, context, nextSky, nextView);
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
