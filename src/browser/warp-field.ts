/**
 * The field the jump flies through (08 Hyperspace): the sky's stars where they
 * stand, plus deep ones around them, rushing past the eye. Pure — the painter
 * (`dom/starfield-canvas.ts`) strokes what `warpStreaks` returns.
 */
import { clamp, seeded, seedOf, type SkyBox } from "./starfield.ts";

/** A star in the jump: `x`/`y` from the sky's centre, `z` its depth. */
export interface WarpStar {
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

/**
 * The stars where they stand, at the depth of the screen, plus `extra` deep
 * ones around them so the jump fills the whole view.
 */
export function warpField(
  points: readonly { x: number; y: number }[],
  box: SkyBox,
  seedText: string,
  extra: number,
): WarpStar[] {
  const random = seeded(seedOf(seedText));
  const depth = box.width / 2;
  const near = points.map(({ x, y }) => ({
    x: x - box.width / 2,
    y: y - box.height / 2,
    z: depth,
    alive: true,
  }));
  const far = Array.from({ length: extra }, () => ({
    x: (random() - 0.5) * box.width * 2.4,
    y: (random() - 0.5) * box.height * 2.4,
    z: depth * (0.4 + random() * 2.4),
    alive: true,
  }));
  return [...near, ...far];
}

/** Depth units per 60 Hz frame: a slow first beat, then a cubic rush. */
export function warpSpeed(ms: number): number {
  return ms < 150 ? 0.6 : 0.6 + ((ms - 150) / 750) ** 3 * 38;
}

/**
 * Moves every star `speed` closer and returns the streak each drew, as flat
 * `x1 y1 x2 y2` runs in three batches by nearness — the painter strokes one
 * path per batch. Mutates `field`: at 780 stars and 60 frames a second a copy
 * per frame is the garbage that would drop frames.
 */
export function warpStreaks(
  field: WarpStar[],
  speed: number,
  box: SkyBox,
): [number[], number[], number[]] {
  const [cx, cy, lens] = [box.width / 2, box.height / 2, box.width / 2];
  const batches: [number[], number[], number[]] = [[], [], []];
  for (const star of field) {
    if (!star.alive) continue;
    const before = star.z;
    star.z -= speed;
    if (star.z < 4) {
      star.alive = false;
      continue;
    }
    const near = clamp(1 - star.z / (lens * 2.2));
    const batch = batches[near > 0.6 ? 2 : near > 0.3 ? 1 : 0];
    batch.push(
      cx + (star.x / before) * lens,
      cy + (star.y / before) * lens,
      cx + (star.x / star.z) * lens,
      cy + (star.y / star.z) * lens,
    );
  }
  return batches;
}
