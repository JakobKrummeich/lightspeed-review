import { test } from "node:test";
import assert from "node:assert/strict";
import { KEEP_OUT, keepOut, type SkyRect } from "../../src/browser/sky-keep-out.ts";
import { layoutSky, type SkyBox, type SkyChapter } from "../../src/browser/starfield.ts";

/**
 * The constellation sheet's button stands in the middle of the sky, where the
 * jump launches from. Nothing the layout draws may stand under it: no star, no
 * figure line, no name — at every desktop size, for small and large reviews.
 */

const DESKTOPS: SkyBox[] = [
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

const REVIEWS: Record<string, number[]> = {
  "one chapter": [30],
  "two chapters": [12, 9],
  "14 files": [5, 4, 5],
  "120 files": [34, 22, 18, 15, 12, 9, 6, 4],
  "400 files": [80, 60, 52, 45, 40, 35, 30, 22, 15, 11, 6, 4],
  "600 files, crowded": [110, 90, 80, 70, 60, 50, 40, 35, 30, 20, 10, 5],
};

function chapters(sizes: number[]): SkyChapter[] {
  return sizes.map((count, chapter) => ({
    name: `Chapter ${chapter + 1} of the review`,
    files: Array.from({ length: count }, (_unused, index) => ({
      path: `src/c${chapter}/f${index}.ts`,
      lines: 1 + ((index * 37 + chapter * 11) % 300),
    })),
  }));
}

function inside(rect: SkyRect, x: number, y: number): boolean {
  return x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;
}

/** Walked a pixel at a time: independent of how the layout decides it. */
function crosses(rect: SkyRect, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y));
  for (let step = 0; step <= steps; step += 1) {
    const k = steps === 0 ? 0 : step / steps;
    if (inside(rect, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k)) return true;
  }
  return false;
}

test("the keep-out is centred on the sky and holds the button with its pulse", () => {
  for (const box of DESKTOPS) {
    const rect = keepOut(box);
    assert.equal(rect.x + rect.width / 2, box.width / 2);
    assert.equal(rect.y + rect.height / 2, box.height / 2);
  }
  // The button is about 200 × 44 px, and its pulse rings out 22 px round it.
  assert.ok(KEEP_OUT.width >= 200 + 2 * 22 && KEEP_OUT.height >= 44 + 2 * 22);
});

for (const [review, sizes] of Object.entries(REVIEWS)) {
  test(`${review}: no star, figure line or name stands under the button, at any desktop size`, () => {
    for (const box of DESKTOPS) {
      const sky = layoutSky(chapters(sizes), box);
      const rect = keepOut(box);
      const at = `${box.width}×${box.height}`;

      for (const star of sky.stars) {
        assert.ok(!inside(rect, star.x, star.y), `a star at ${star.x},${star.y} (${at})`);
      }
      for (const [a, b] of sky.figures.flat()) {
        const [from, to] = [sky.stars[a], sky.stars[b]];
        assert.ok(from && to);
        assert.ok(!crosses(rect, from, to), `a figure line crosses it (${at})`);
      }
      for (const label of sky.labels) {
        const apart =
          label.x + label.width / 2 <= rect.x ||
          label.x - label.width / 2 >= rect.x + rect.width ||
          label.y + label.height <= rect.y ||
          label.y >= rect.y + rect.height;
        assert.ok(apart, `${label.name} under the button (${at})`);
      }
      assert.ok(sky.labels.length > 0, `names still come up (${at})`);
    }
  });
}

test("the sky reaches the bottom of the window again: no strip is kept for the button", () => {
  const box = { width: 1440, height: 900 };
  const sky = layoutSky(chapters(REVIEWS["120 files"] ?? []), box);

  assert.ok(sky.stars.some((star) => star.y > box.height - 128));
});

test("a lone chapter rings the button rather than hiding under it", () => {
  const box = { width: 1440, height: 900 };
  const sky = layoutSky(chapters([30]), box);
  const rect = keepOut(box);

  const above = sky.stars.filter((star) => star.y < rect.y).length;
  const below = sky.stars.filter((star) => star.y > rect.y + rect.height).length;
  assert.ok(above > 0 && below > 0, "stars on both sides of it");
});
