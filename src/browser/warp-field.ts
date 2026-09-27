/**
 * The field the jump flies through: the sky's stars where they stand, plus
 * deep ones around them. Pure; `dom/starfield-canvas.ts` strokes the streaks.
 */
import { seeded, seedOf, type SkyBox } from "./starfield.ts";

/**
 * `x`/`y` from the sky's centre, `z` the depth; a star is gone once `z` is
 * under `PAST_EYE`. Typed columns rather than an object per star: a double
 * written to an object field is boxed, which is garbage every frame.
 */
export interface WarpField {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
}

/** Nearer than this and a star has flown past the eye. */
export const PAST_EYE = 4;

/** `extra` deep stars so even a one-file review fills the view. */
export function warpField(
  points: readonly { x: number; y: number }[],
  box: SkyBox,
  seedText: string,
  extra: number,
): WarpField {
  const random = seeded(seedOf(seedText));
  const depth = box.width / 2;
  const count = points.length + extra;
  const field = {
    x: new Float64Array(count),
    y: new Float64Array(count),
    z: new Float64Array(count),
  };
  points.forEach(({ x, y }, index) => {
    field.x[index] = x - box.width / 2;
    field.y[index] = y - box.height / 2;
    field.z[index] = depth;
  });
  for (let index = points.length; index < count; index += 1) {
    field.x[index] = (random() - 0.5) * box.width * 2.4;
    field.y[index] = (random() - 0.5) * box.height * 2.4;
    field.z[index] = depth * (0.4 + random() * 2.4);
  }
  return field;
}

/**
 * Depth units per 60 Hz frame: a slow first beat, then a cubic rush. Scaled
 * by width because depth is measured in view widths (570 px is the reference).
 */
export function warpSpeed(ms: number, box: SkyBox): number {
  const rush = ms < 150 ? 0.6 : 0.6 + ((ms - 150) / 750) ** 3 * 38;
  return rush * (box.width / 570);
}

/**
 * One frame's streaks as flat `x1 y1 x2 y2` runs in three batches by
 * nearness: batch `b` is `runs[b]` up to `ends[b]`. Reused every frame.
 */
export interface StreakBatches {
  runs: [Float32Array, Float32Array, Float32Array];
  ends: [number, number, number];
}

/** Room for every one of `stars` in any batch, since all of them can be near at once. */
export function streakBatches(stars: number): StreakBatches {
  const run = (): Float32Array => new Float32Array(stars * 4);
  return { runs: [run(), run(), run()], ends: [0, 0, 0] };
}

/**
 * Moves every star `speed` closer and writes its streak into `into`.
 * Mutates both and allocates no arrays: this runs every frame.
 */
export function warpStreaks(
  field: WarpField,
  speed: number,
  box: SkyBox,
  into: StreakBatches = streakBatches(field.z.length),
): StreakBatches {
  const focal = box.width / 2;
  // Nearness is 1 - z / (2.2 focal): past 0.6 is the near batch, past 0.3 the middle.
  const lens: Lens = {
    cx: box.width / 2,
    cy: box.height / 2,
    focal,
    near: focal * 0.88,
    middle: focal * 1.54,
  };
  into.ends[0] = 0;
  into.ends[1] = 0;
  into.ends[2] = 0;
  for (let index = 0; index < field.z.length; index += 1) {
    if (field.z[index]! >= PAST_EYE) fly(field, index, speed, lens, into);
  }
  return into;
}

/** The eye at the sky's centre, `focal` from the screen; `near`/`middle` the batches' depths. */
interface Lens {
  cx: number;
  cy: number;
  focal: number;
  near: number;
  middle: number;
}

/**
 * Few temporaries on purpose: until the engine optimises this, every
 * intermediate number is a heap object.
 */
function fly(field: WarpField, at: number, speed: number, lens: Lens, into: StreakBatches): void {
  const before = field.z[at]!;
  const z = before - speed;
  field.z[at] = z;
  if (z < PAST_EYE) return;
  const batch = z < lens.near ? 2 : z < lens.middle ? 1 : 0;
  const x = field.x[at]!;
  const y = field.y[at]!;
  const from = lens.focal / before;
  const to = lens.focal / z;
  const run = into.runs[batch];
  const end = into.ends[batch];
  run[end] = lens.cx + x * from;
  run[end + 1] = lens.cy + y * from;
  run[end + 2] = lens.cx + x * to;
  run[end + 3] = lens.cy + y * to;
  into.ends[batch] = end + 4;
}
