import { test } from "node:test";
import assert from "node:assert/strict";
import { keepOut } from "../../src/browser/sky-keep-out.ts";
import {
  layoutSky,
  type Sky,
  type SkyBox,
  type SkyChapter,
  type SkyLabel,
} from "../../src/browser/starfield.ts";

/**
 * Every chapter on the constellation sheet is named — a review of 16 chapters
 * showed some figures with no name — and no two names overlap.
 */

const NAMES = [
  "CLI verbs",
  "Session state",
  "Browser chat",
  "Grouping provider fallback",
  "Opening room",
  "Progress bar",
  "Docs",
  "Tests",
  "Config file migration",
  "Theme palette",
  "Skill text",
  "Replay overlay and its cards",
  "Round arrival",
  "Caret return",
  "Keyboard shortcuts",
  "Stylesheet boundaries",
  "Build scripts",
  "Release notes",
  "Server handlers",
  "Diff extraction",
];

/** Near the page's bold 14 px face: wider than the Latin estimate's floor would guess. */
const measure = (text: string): number => text.length * 8;

function chapters(count: number): SkyChapter[] {
  return NAMES.slice(0, count).map((name, chapter) => ({
    name,
    files: Array.from({ length: 4 + ((chapter * 7) % 30) }, (_unused, index) => ({
      path: `src/c${chapter}/f${index}.ts`,
      lines: 1 + ((index * 37 + chapter * 11) % 300),
    })),
  }));
}

function overlap(a: SkyLabel, b: SkyLabel): boolean {
  return (
    Math.abs(a.x - b.x) < (a.width + b.width) / 2 && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

function assertLegible(sky: Sky, box: SkyBox, at: string): void {
  const rect = keepOut(box);
  for (const [index, label] of sky.labels.entries()) {
    assert.ok(label.x - label.width / 2 >= 0 && label.x + label.width / 2 <= box.width, at);
    assert.ok(label.y >= 0 && label.y + label.height <= box.height, `${label.name} (${at})`);
    const clear =
      label.x + label.width / 2 <= rect.x ||
      label.x - label.width / 2 >= rect.x + rect.width ||
      label.y + label.height <= rect.y ||
      label.y >= rect.y + rect.height;
    assert.ok(clear, `${label.name} under the button (${at})`);
    for (const other of sky.labels.slice(index + 1)) {
      assert.ok(!overlap(label, other), `${label.name} overlaps ${other.name} (${at})`);
    }
  }
}

const SIZES: SkyBox[] = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
];

for (const count of [16, 20]) {
  test(`${count} chapters: every one named, none overlapping, none under the button`, () => {
    for (const box of SIZES) {
      const at = `${count} chapters at ${box.width}×${box.height}`;
      const sky = layoutSky(chapters(count), box, measure);

      assert.deepEqual(
        sky.labels.map((label) => label.chapter),
        Array.from({ length: count }, (_unused, index) => index),
        at,
      );
      assertLegible(sky, box, at);
    }
  });

  test(`${count} chapters: each name stands by its own constellation, off the others' stars`, () => {
    for (const box of SIZES) {
      const at = `${count} chapters at ${box.width}×${box.height}`;
      const sky = layoutSky(chapters(count), box, measure);

      for (const label of sky.labels) {
        const own = sky.stars.filter((star) => star.chapter === label.chapter);
        const reach = Math.min(
          ...own.map((star) =>
            Math.hypot(
              Math.max(0, Math.abs(star.x - label.x) - label.width / 2),
              Math.max(0, label.y - star.y, star.y - label.y - label.height),
            ),
          ),
        );
        assert.ok(reach < 60, `${label.name} is ${Math.round(reach)} px from its stars (${at})`);
        const under = sky.stars.filter(
          (star) =>
            star.chapter !== label.chapter &&
            Math.abs(star.x - label.x) < label.width / 2 &&
            star.y > label.y &&
            star.y < label.y + label.height,
        );
        assert.equal(under.length, 0, `${label.name} covers another chapter's stars (${at})`);
      }
    }
  });
}

test("no name is ever dropped: with no free room left, every chapter still gets one", () => {
  const box = { width: 480, height: 320 };
  const sky = layoutSky(chapters(20), box, measure);

  assert.equal(sky.labels.length, 20);
  for (const label of sky.labels) {
    assert.ok(label.x - label.width / 2 >= 0 && label.x + label.width / 2 <= box.width);
    assert.ok(label.y >= 0 && label.y + label.height <= box.height);
  }
});

test("a chapter with no star on the sky has no name to stand by", () => {
  const sky = layoutSky([...chapters(3), { name: "Empty", files: [] }], SIZES[0]!, measure);

  assert.deepEqual(
    sky.labels.map((label) => label.name),
    ["CLI verbs", "Session state", "Browser chat"],
  );
});
