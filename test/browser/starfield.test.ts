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
  type SkyLabel,
} from "../../src/browser/starfield.ts";
import {
  PAST_EYE,
  streakBatches,
  warpField,
  warpSpeed,
  warpStreaks,
  type WarpField,
} from "../../src/browser/warp-field.ts";

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
  assert.equal(byLines[0]?.magnitude, 0.15, "a file with no lines is the faintest star, not dust");
  // Logarithmic: ten times the lines is far less than ten times the light.
  const at = (lines: number): number =>
    sky.stars.find((star) => star.lines === lines)?.magnitude ?? 0;
  assert.ok(at(40) / at(9) < 2);
});

test("a review of files with no lines at all is a sky of faint stars, not dust or NaN", () => {
  // Renames and binaries change no lines: a chapter of them was a figure with no stars on it.
  const sky = layoutSky([{ name: "Binary", files: [{ path: "a.png", lines: 0 }] }], BOX);

  assert.equal(sky.stars[0]?.magnitude, 0.15);
});

test("a chapter of renames beside a big one still shows its stars", () => {
  const sky = layoutSky(
    [
      { name: "Big", files: [{ path: "big.ts", lines: 5000 }] },
      { name: "Renames", files: ["a", "b", "c"].map((path) => ({ path, lines: 0 })) },
    ],
    BOX,
  );

  const renames = sky.stars.filter((star) => star.chapter === 1);
  assert.equal(renames.length, 3);
  assert.ok(renames.every((star) => star.magnitude === 0.15));
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
  // Four stars off to one side, clear of the button's box (a lone chapter rings it, and its
  // figure may not cross it: `sky-keep-out.test.ts`).
  const sky = layoutSky(chapters([4, 1]), BOX);
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
  assertApart(sky.labels);
});

/** Side by side or one wholly above the other, whatever height each name takes. */
function assertApart(labels: SkyLabel[]): void {
  for (const [index, a] of labels.entries()) {
    for (const b of labels.slice(index + 1)) {
      const apart =
        Math.abs(a.x - b.x) >= (a.width + b.width) / 2 ||
        a.y >= b.y + b.height ||
        b.y >= a.y + a.height;
      assert.ok(apart, `${a.name} overlaps ${b.name}`);
    }
  }
}

test("a name that would overlap is passed over for the next largest, still up to eight", () => {
  // At phone width the fourth chapter's name lands on another; cutting to the top eight
  // before asking would leave seven names up and the ninth chapter's room unused.
  const sky = layoutSky(chapters([80, 60, 52, 45, 40, 35, 30, 22, 15, 11, 6, 4]), {
    width: 375,
    height: 540,
  });

  assert.equal(sky.labels.length, MOST_NAMES);
  assert.deepEqual(
    sky.labels.map((label) => label.chapter),
    [0, 1, 2, 4, 5, 6, 7, 8],
  );
  assertApart(sky.labels);
});

test("a long chapter name takes a second line rather than an ellipsis at 24 characters", () => {
  const long = "Parser learns streaming tokens from the new lexer";
  const named = (name: string, box = BOX) =>
    layoutSky([{ name, files: [{ path: "a.ts", lines: 3 }] }], box).labels[0];

  const short = named("Docs");
  const wide = named(long);
  assert.equal(short?.height, 38, "one line and its count");
  assert.equal(wide?.width, 240, "as wide as a name may be");
  assert.equal(wide?.height, 38 + 18, "a second line, budgeted before the overlap check");
  assert.equal(named("Session state, its store")?.width, 24 * 9 + 12, "fits: one line");
  assert.equal(named("Session state, its store")?.height, 38);

  const phone = named(long, { width: 200, height: 400 });
  assert.equal(phone?.width, 200 - 24, "never wider than the sky it stands in");
});

test("a name is as wide as the page measures it, not as its letter count guesses", () => {
  // CJK glyphs are near a full em each: 13 of them guessed at 9px apiece came out 70px narrow,
  // and two such names overlapped at 375×667.
  const name = "会话状态持久化与恢复机制啊";
  const full = (text: string): number => [...text].length * 14;
  const named = (measure?: (text: string) => number) =>
    layoutSky([{ name, files: [{ path: "a.ts", lines: 3 }] }], BOX, measure).labels[0];

  assert.equal(named(full)?.width, 13 * 14 + 12, "the measured width, and one line");
  assert.equal(named(full)?.height, 38);
  assert.equal(named()?.width, 13 * 9 + 12, "no measure: the estimate");
  const twice = layoutSky([{ name: name + name, files: [{ path: "a.ts", lines: 3 }] }], BOX, full);
  assert.equal(twice.labels[0]?.width, 240, "wider than a name may be: the widest, two lines");
  assert.equal(twice.labels[0]?.height, 56);
});

test("measured wide names still keep off each other on a phone", () => {
  const cjk = [
    "用户界面更新与改进用户界面",
    "会话状态持久化与恢复机制啊",
    "命令行动词一致性修复工作",
  ];
  const full = (text: string): number => [...text].length * 14;
  const sky = layoutSky(
    [...cjk, "进度条显示与更新逻辑", "文档全部新功能说明书", "测试覆盖所有边界情况"].map(
      (name, chapter) => ({
        name,
        files: Array.from({ length: 20 - chapter }, (_unused, index) => ({
          path: `c${chapter}/f${index}`,
          lines: index + 1,
        })),
      }),
    ),
    { width: 375, height: 539 },
    full,
  );

  assert.ok(sky.labels.length > 1);
  for (const label of sky.labels) assert.ok(label.width >= Math.min(240, full(label.name) + 12));
  assertApart(sky.labels);
});

test("two-line names still keep off each other and inside the sky", () => {
  const sizes = [30, 25, 20, 18, 15, 12];
  const sky = layoutSky(
    sizes.map((count, chapter) => ({
      name: `Chapter ${chapter + 1} with a name long enough to wrap onto a second line`,
      files: Array.from({ length: count }, (_unused, index) => ({
        path: `c${chapter}/f${index}`,
        lines: index + 1,
      })),
    })),
    { width: 1024, height: 472 },
  );

  assert.ok(sky.labels.length > 1);
  assert.ok(sky.labels.every((label) => label.height === 56));
  assert.ok(sky.labels.every((label) => label.y + label.height <= 472));
  assertApart(sky.labels);
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

/** Stars still ahead of the eye. */
function flying(field: WarpField): number {
  return field.z.filter((z) => z >= PAST_EYE).length;
}

test("the jump starts from where the stars stand, plus a deep field around them", () => {
  const field = warpField([{ x: 720, y: 385 }], BOX, "seed", 10);

  assert.equal(field.z.length, 11);
  assert.deepEqual([field.x[0], field.y[0], field.z[0]], [0, 0, BOX.width / 2]);
  assert.equal(flying(field), 11);
  assert.deepEqual(warpField([], BOX, "seed", 10), warpField([], BOX, "seed", 10));
});

test("the jump slows in, then races: the speed only ever grows", () => {
  let before = -1;
  for (let ms = 0; ms <= SKY_TIMES.jumpMs; ms += 25) {
    const speed = warpSpeed(ms, BOX);
    assert.ok(speed >= before, `slower at ${ms}ms`);
    before = speed;
  }
  assert.ok(warpSpeed(SKY_TIMES.jumpMs, BOX) > warpSpeed(0, BOX) * 20);
  // Depth is measured in view widths: a wider view rushes as fast to the eye.
  assert.equal(
    warpSpeed(500, { width: 1140, height: 1 }),
    warpSpeed(500, { width: 570, height: 1 }) * 2,
  );
});

test("streaks come in three batches by depth, and a star past the eye is gone", () => {
  const field = warpField([], BOX, "streaks", 200);
  const streaks = warpStreaks(field, 4, BOX);

  assert.equal(streaks.runs.length, 3);
  for (const end of streaks.ends) assert.equal(end % 4, 0, "four numbers a streak");
  const drawn = streaks.ends.reduce((sum, end) => sum + end / 4, 0);
  assert.equal(drawn, flying(field));

  for (let frame = 0; frame < 400; frame += 1) warpStreaks(field, 40, BOX, streaks);
  assert.equal(flying(field), 0, "every star flew past");
  assert.deepEqual(warpStreaks(field, 40, BOX).ends, [0, 0, 0]);
});

test("the streaks of every frame are written into the same buffers, never new ones", () => {
  // 60 frames a second of fresh arrays was 5.7 MB/s of garbage at 780 stars.
  const field = warpField([{ x: 10, y: 10 }], BOX, "reuse", 300);
  const batches = streakBatches(field.z.length);
  const runs = [...batches.runs];

  const first = warpStreaks(field, 4, BOX, batches);
  const second = warpStreaks(field, 4, BOX, batches);

  assert.equal(first, batches);
  assert.equal(second, batches);
  assert.deepEqual(batches.runs, runs, "the same three buffers");
  assert.ok(
    runs.every((run) => run.length >= field.z.length * 4),
    "room for every star",
  );
  const [x1, y1, x2, y2] = [...batches.runs[2].slice(0, 4)];
  assert.ok([x1, y1, x2, y2].every(Number.isFinite), "a near streak reads as numbers");
});

test("a drifting star can be placed into an object the painter keeps", () => {
  const [star] = layoutSky(chapters([1]), BOX).stars;
  assert.ok(star);
  const kept = { x: -1, y: -1 };

  const placed = driftAt(star, 12.5, BOX, kept);

  assert.equal(placed, kept, "no new object a frame");
  assert.deepEqual(kept, driftAt(star, 12.5, BOX));
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
