import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MOST_NAMES,
  MOST_STARS,
  FIGURE_STARS,
  SKY_TIMES,
  driftAt,
  gathered,
  layoutSky,
  seeded,
  seedOf,
  skyChapters,
  type SkyChapter,
} from "../../src/browser/starfield.ts";
import { warpField, warpSpeed, warpStreaks } from "../../src/browser/warp-field.ts";

const BOX = { width: 1440, height: 770 };

/** `sizes[c]` files in chapter c, with line counts spread by a fixed walk. */
function chapters(sizes: number[]): SkyChapter[] {
  return sizes.map((count, chapter) => ({
    name: `Chapter ${chapter + 1}`,
    files: Array.from({ length: count }, (_unused, index) => ({
      path: `src/c${chapter}/f${index}.ts`,
      lines: 1 + ((index * 37 + chapter * 11) % 300),
    })),
  }));
}

test("the same review lays out the same sky, every time it is drawn", () => {
  const first = layoutSky(chapters([5, 4, 5]), BOX);
  const again = layoutSky(chapters([5, 4, 5]), BOX);

  assert.deepEqual(again, first);
});

test("a different review lays out a different sky", () => {
  const renamed = chapters([5, 4, 5]).map((chapter) => ({ ...chapter, name: `${chapter.name}!` }));

  assert.notDeepEqual(layoutSky(renamed, BOX).stars, layoutSky(chapters([5, 4, 5]), BOX).stars);
});

test("the seeded source is repeatable and stays inside [0, 1)", () => {
  const a = seeded(seedOf("lightspeed"));
  const b = seeded(seedOf("lightspeed"));
  const draws = Array.from({ length: 500 }, () => a());

  assert.deepEqual(
    Array.from({ length: 500 }, () => b()),
    draws,
  );
  assert.ok(draws.every((draw) => draw >= 0 && draw < 1));
  assert.notEqual(seedOf("a"), seedOf("b"));
  assert.ok(seedOf("") > 0, "a seed of zero would draw zeroes forever");
});

test("every star, drifting or formed, and every name is inside the sky", () => {
  for (const sizes of [
    [5, 4, 5],
    [34, 22, 18, 15, 12, 9, 6, 4],
    [80, 60, 52, 45, 40, 35, 30, 22, 15, 11, 6, 4],
    [1],
    [300, 300, 1],
  ]) {
    for (const box of [BOX, { width: 420, height: 640 }, { width: 900, height: 380 }]) {
      const sky = layoutSky(chapters(sizes), box);
      for (const star of sky.stars) {
        assert.ok(star.x >= 0 && star.x <= box.width, `x ${star.x} outside ${box.width}`);
        assert.ok(star.y >= 0 && star.y <= box.height, `y ${star.y} outside ${box.height}`);
        assert.ok(star.fromX >= 0 && star.fromX <= box.width);
        assert.ok(star.fromY >= 0 && star.fromY <= box.height);
        const drifted = driftAt(star, 97.3, box);
        assert.ok(drifted.x >= 0 && drifted.x <= box.width);
        assert.ok(drifted.y >= 0 && drifted.y <= box.height);
      }
      for (const label of sky.labels) {
        assert.ok(label.x - label.width / 2 >= 0 && label.x + label.width / 2 <= box.width);
        assert.ok(label.y >= 0 && label.y + label.height <= box.height);
      }
    }
  }
});

test("one star per file, and no more than the sky can hold", () => {
  assert.equal(layoutSky(chapters([5, 4, 5]), BOX).stars.length, 14);
  assert.equal(layoutSky(chapters([400, 300, 250]), BOX).stars.length, MOST_STARS);
  assert.equal(MOST_STARS, 600);
});

test("past the cap, the largest files are the ones drawn", () => {
  const big = chapters([400, 300, 250]);
  const sky = layoutSky(big, BOX);
  const faintestDrawn = Math.min(...sky.stars.map((star) => star.lines));
  const drawn = new Set(sky.stars.map((star) => star.path));
  const left = big.flatMap((chapter) => chapter.files).filter((file) => !drawn.has(file.path));

  assert.equal(left.length, 950 - MOST_STARS);
  assert.ok(
    left.every((file) => file.lines <= faintestDrawn),
    "a file left out outshone one drawn",
  );
});

test("brightness follows the lines changed, on a log scale", () => {
  const sky = layoutSky(
    [
      {
        name: "Sizes",
        files: [0, 1, 2, 9, 40, 400].map((lines) => ({ path: `f${lines}`, lines })),
      },
    ],
    BOX,
  );
  const byLines = [...sky.stars].sort((a, b) => a.lines - b.lines);

  for (let index = 1; index < byLines.length; index += 1) {
    const [before, after] = [byLines[index - 1], byLines[index]];
    assert.ok(before && after && before.magnitude < after.magnitude, "more lines, brighter star");
  }
  assert.equal(byLines.at(-1)?.magnitude, 1, "the largest file is the brightest star");
  assert.equal(byLines[0]?.magnitude, 0, "a file with no lines is dust");
  // Logarithmic: ten times the lines is far less than ten times the light.
  const at = (lines: number): number =>
    sky.stars.find((star) => star.lines === lines)?.magnitude ?? 0;
  assert.ok(at(40) / at(9) < 2);
});

test("a review of files with no lines at all is still a sky of dust, not NaN", () => {
  const sky = layoutSky([{ name: "Binary", files: [{ path: "a.png", lines: 0 }] }], BOX);

  assert.equal(sky.stars[0]?.magnitude, 0);
});

test("each figure joins its chapter's seven brightest stars and nothing else", () => {
  const sizes = [1, 2, 7, 8, 40];
  const sky = layoutSky(chapters(sizes), BOX);

  assert.equal(FIGURE_STARS, 7);
  assert.deepEqual(
    sky.figures.map((edges) => edges.length),
    sizes.map((size) => Math.min(FIGURE_STARS, size) - 1),
  );
  for (const [chapter, edges] of sky.figures.entries()) {
    const mine = sky.stars
      .map((star, index) => ({ star, index }))
      .filter(({ star }) => star.chapter === chapter)
      .sort((a, b) => b.star.magnitude - a.star.magnitude);
    const brightest = new Set(mine.slice(0, FIGURE_STARS).map(({ index }) => index));
    const joined = new Set(edges.flat());
    for (const index of joined) assert.ok(brightest.has(index), "a faint star is in the figure");
    if (edges.length > 0)
      assert.equal(joined.size, edges.length + 1, "a tree: every star reached once");
  }
});

test("a figure is the shortest tree over its stars", () => {
  // Four stars on a line: the minimum spanning tree joins neighbours only.
  const sky = layoutSky(chapters([4]), BOX);
  const [edges = []] = sky.figures;
  const length = (a: number, b: number): number => {
    const [p, q] = [sky.stars[a], sky.stars[b]];
    return p && q ? Math.hypot(p.x - q.x, p.y - q.y) : Infinity;
  };
  const total = edges.reduce((sum, [a, b]) => sum + length(a, b), 0);
  // Every other spanning tree over four points is one of 16; none is shorter.
  const all: [number, number][] = [];
  for (let a = 0; a < 4; a += 1) for (let b = a + 1; b < 4; b += 1) all.push([a, b]);
  let shortest = Infinity;
  for (let mask = 0; mask < 1 << all.length; mask += 1) {
    const picked = all.filter((_edge, index) => mask & (1 << index));
    if (picked.length !== 3 || !spans(picked, 4)) continue;
    shortest = Math.min(
      shortest,
      picked.reduce((sum, [a, b]) => sum + length(a, b), 0),
    );
  }
  assert.ok(Math.abs(total - shortest) < 1e-9);
});

function spans(edges: [number, number][], count: number): boolean {
  const reached = new Set([0]);
  for (let pass = 0; pass < count; pass += 1) {
    for (const [a, b] of edges) if (reached.has(a) || reached.has(b)) reached.add(a).add(b);
  }
  return reached.size === count;
}

test("no more than eight names, the largest chapters first, none overlapping", () => {
  const sky = layoutSky(chapters([80, 60, 52, 45, 40, 35, 30, 22, 15, 11, 6, 4]), BOX);

  assert.equal(MOST_NAMES, 8);
  assert.ok(sky.labels.length <= MOST_NAMES);
  assert.ok(sky.labels.length > 0);
  assert.ok(
    sky.labels.every((label) => label.chapter < MOST_NAMES),
    "a small chapter took a name",
  );
  for (const [index, a] of sky.labels.entries()) {
    for (const b of sky.labels.slice(index + 1)) {
      const apart =
        Math.abs(a.x - b.x) >= (a.width + b.width) / 2 || Math.abs(a.y - b.y) >= a.height;
      assert.ok(apart, `${a.name} overlaps ${b.name}`);
    }
  }
});

test("a name says which chapter and how many files it has", () => {
  const sky = layoutSky(chapters([5, 1]), BOX);

  assert.deepEqual(
    sky.labels.map(({ name, files }) => [name, files]),
    [
      ["Chapter 1", 5],
      ["Chapter 2", 1],
    ],
  );
});

test("a chapter every file of which fell under the cap has no stars, no figure and no name", () => {
  const big = chapters([700]);
  const faint = { name: "Faint", files: [{ path: "tiny.md", lines: 0 }] };
  const sky = layoutSky([...big, faint], BOX);

  assert.equal(sky.stars.filter((star) => star.chapter === 1).length, 0);
  assert.deepEqual(sky.figures[1], []);
  assert.ok(sky.labels.every((label) => label.chapter !== 1));
});

test("an empty review is an empty sky", () => {
  assert.deepEqual(layoutSky([], BOX), { box: BOX, stars: [], figures: [], labels: [] });
});

test("gathering eases from nothing to formed over its own time", () => {
  assert.equal(gathered(-5), 0);
  assert.equal(gathered(0), 0);
  assert.equal(gathered(SKY_TIMES.gatherMs), 1);
  assert.equal(gathered(SKY_TIMES.gatherMs * 3), 1);
  const half = gathered(SKY_TIMES.gatherMs / 2);
  assert.ok(half > 0.4 && half < 0.6);
});

test("the names come once the figures have formed, and the button after them", () => {
  assert.ok(SKY_TIMES.namesAtMs >= SKY_TIMES.figureAtMs + SKY_TIMES.figureFadeMs);
  assert.ok(SKY_TIMES.namesAtMs >= SKY_TIMES.gatherMs);
  assert.equal(SKY_TIMES.heldAfterNamesMs, 1500);
  assert.ok(SKY_TIMES.flashAtMs < SKY_TIMES.jumpMs, "the flash covers the swap");
});

test("the jump starts from where the stars stand, plus a deep field around them", () => {
  const field = warpField([{ x: 720, y: 385 }], BOX, "seed", 10);

  assert.equal(field.length, 11);
  assert.deepEqual(field[0], { x: 0, y: 0, z: BOX.width / 2, alive: true });
  assert.deepEqual(warpField([], BOX, "seed", 10), warpField([], BOX, "seed", 10));
});

test("the jump slows in, then races: the speed only ever grows", () => {
  let before = -1;
  for (let ms = 0; ms <= SKY_TIMES.jumpMs; ms += 25) {
    const speed = warpSpeed(ms);
    assert.ok(speed >= before, `slower at ${ms}ms`);
    before = speed;
  }
  assert.ok(warpSpeed(SKY_TIMES.jumpMs) > warpSpeed(0) * 20);
});

test("streaks come in three batches by depth, and a star past the eye is gone", () => {
  const field = warpField([], BOX, "streaks", 200);
  const streaks = warpStreaks(field, 4, BOX);

  assert.equal(streaks.length, 3);
  for (const batch of streaks) assert.equal(batch.length % 4, 0, "four numbers a streak");
  const drawn = streaks.reduce((sum, batch) => sum + batch.length / 4, 0);
  assert.equal(drawn, field.filter((star) => star.alive).length);

  for (let frame = 0; frame < 400; frame += 1) warpStreaks(field, 40, BOX);
  assert.ok(
    field.every((star) => !star.alive),
    "every star flew past",
  );
  assert.deepEqual(warpStreaks(field, 40, BOX), [[], [], []]);
});

test("the page's chapters become the sky's: a file weighs every line it changed", () => {
  const file = { status: "modified" as const, diff: "", oversized: false };
  const sky = skyChapters([
    {
      name: "Schema",
      rationale: "why",
      files: [{ ...file, path: "src/db.ts", insertions: 12, deletions: 3 }],
    },
  ]);

  assert.deepEqual(sky, [{ name: "Schema", files: [{ path: "src/db.ts", lines: 15 }] }]);
});
