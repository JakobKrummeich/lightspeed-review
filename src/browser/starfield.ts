/**
 * The sky the first round opens on (07 Constellations) and the field the jump
 * flies through (08 Hyperspace): every file is a star, every chapter a
 * constellation. Pure layout and nothing else — no DOM, no clock, no
 * `Math.random` — so the same review draws the same sky on every reload and a
 * test can say where every star stands. `dom/starfield-canvas.ts` paints it.
 */
import type { DiffGroup } from "../diff-extract.ts";

export interface SkyFile {
  path: string;
  /** Changed lines, insertions plus deletions. */
  lines: number;
}

export interface SkyChapter {
  name: string;
  files: readonly SkyFile[];
}

export interface SkyBox {
  width: number;
  height: number;
}

export interface Star {
  chapter: number;
  path: string;
  lines: number;
  /** 0 (dust) to 1 (the largest file in the review), on a log scale. */
  magnitude: number;
  /** Its place in the formed constellation. */
  x: number;
  y: number;
  /** Where it drifts from while the reasons are read, and how fast (px/s). */
  fromX: number;
  fromY: number;
  driftX: number;
  driftY: number;
  /** Twinkle phase, radians. */
  twinkle: number;
}

/** `x` is the name's centre, `y` its top; `width`/`height` the box it may not share. */
export interface SkyLabel {
  chapter: number;
  name: string;
  files: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Sky {
  box: SkyBox;
  stars: Star[];
  /** Per chapter, in review order: edges as pairs of indexes into `stars`. */
  figures: [number, number][][];
  labels: SkyLabel[];
}

/** The page's chapters as the sky reads them: a file's weight is every line it changed. */
export function skyChapters(groups: readonly DiffGroup[]): SkyChapter[] {
  return groups.map((group) => ({
    name: group.name,
    files: group.files.map((file) => ({
      path: file.path,
      lines: file.insertions + file.deletions,
    })),
  }));
}

/** Past this a sky is a crowd, and the painter's 4 ms budget was measured at it. */
export const MOST_STARS = 600;
/** Real constellations skip their faint stars: 40 files read as a cluster with a figure in it. */
export const FIGURE_STARS = 7;
export const MOST_NAMES = 8;

/**
 * One clock for the painter and the overlay, in ms from the moment each phase
 * starts: gathering from the constellation sheet's arrival, the jump from the
 * last press. The names wait for the figures to finish forming; the button
 * waits 1.5 s more, so the chapters are looked at before they are left.
 */
export const SKY_TIMES = {
  gatherMs: 1700,
  figureAtMs: 1500,
  figureFadeMs: 800,
  namesAtMs: 2400,
  heldAfterNamesMs: 1500,
  flashAtMs: 800,
  jumpMs: 1000,
} as const;

const EDGE = 12;
/** A one-line name and its count, px; each further line of the name adds `NAME_LINE`. */
const NAME_HEIGHT = 38;
const NAME_LINE = 18;
const NAME_GAP = 6;
/** The widest a name may be; a longer one takes a second line, then an ellipsis. */
const NAME_WIDEST = 240;
/** A bold meta-size character, generously: a name wider than its box is clipped. */
const CHAR_WIDTH = 9;

/** Park–Miller: tiny, repeatable, and good enough to scatter stars. */
export function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** FNV-1a folded into Park–Miller's range, which excludes zero. */
export function seedOf(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash % 2147483646) + 1;
}

export function clamp(value: number, low = 0, high = 1): number {
  return Math.max(low, Math.min(high, value));
}

function easeInOut(k: number): number {
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
}

/** How far the files have gathered into their figures, `ms` after the sheet arrived. */
export function gathered(ms: number): number {
  return easeInOut(clamp(ms / SKY_TIMES.gatherMs));
}

/** How visible the figure lines are, `ms` after the sheet arrived. */
export function figureShown(ms: number): number {
  return clamp((ms - SKY_TIMES.figureAtMs) / SKY_TIMES.figureFadeMs);
}

function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

/**
 * Wraps round the sky, so a drifting field never empties. Written into
 * `into` when given: the painter places every star every frame, and keeps
 * one object per star for it rather than making 600 new ones.
 */
export function driftAt(
  star: Star,
  seconds: number,
  box: SkyBox,
  into: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  into.x = wrap(star.fromX + star.driftX * seconds, box.width);
  into.y = wrap(star.fromY + star.driftY * seconds, box.height);
  return into;
}

interface Kept extends SkyFile {
  chapter: number;
}

/** The `MOST_STARS` largest files; ties broken by path, so the cut is stable. */
function keptFiles(chapters: readonly SkyChapter[]): Kept[] {
  const all = chapters.flatMap((chapter, index) =>
    chapter.files.map((file) => ({ ...file, chapter: index })),
  );
  if (all.length <= MOST_STARS) return all;
  return [...all].sort(byWeight).slice(0, MOST_STARS);
}

function byWeight(a: SkyFile, b: SkyFile): number {
  return b.lines - a.lines || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/**
 * Chapter centres in review order, left to right: one in the middle, a few
 * along an arc, a crowd clockwise round a ring — past six an arc runs out of
 * room. Centred on the sky's middle whatever shape they make.
 */
function centres(count: number, box: SkyBox): [number, number][] {
  // A few chapters sit closer in: spread across the whole width they read as
  // three strangers, not one sky.
  const reach = count <= 3 ? 0.28 : 0.38;
  const [cx, cy, rx, ry] = [box.width / 2, box.height / 2, box.width * reach, box.height * 0.36];
  if (count === 1) return [[cx, cy]];
  const ring = count > 6;
  const [from, to] = count <= 3 ? [0.18, 0.82] : [0.02, 0.98];
  const raw = Array.from({ length: count }, (_unused, index): [number, number] => {
    const turn = ring
      ? Math.PI * (0.1 + (2 * index) / count)
      : Math.PI * (from + ((to - from) * index) / (count - 1));
    return [cx - rx * Math.cos(turn), (ring ? -ry : ry) * Math.sin(turn)];
  });
  const heights = raw.map(([, y]) => y);
  const middle = (Math.min(...heights) + Math.max(...heights)) / 2;
  return raw.map(([x, y]) => [x, cy + y - middle]);
}

function closestGap(points: [number, number][], box: SkyBox): number {
  let gap = Math.min(box.width, box.height);
  for (const [index, [x, y]] of points.entries()) {
    for (const [ox, oy] of points.slice(index + 1)) gap = Math.min(gap, Math.hypot(x - ox, y - oy));
  }
  return gap;
}

interface Scope {
  box: SkyBox;
  random: () => number;
  most: number;
}

/**
 * A cluster spirals out from its centre, biggest file in the middle (the
 * golden angle keeps the spiral from lining up). Stars and their drift are
 * both kept inside the sky.
 */
function cluster(files: Kept[], centre: [number, number], radius: number, scope: Scope): Star[] {
  const { box, random, most } = scope;
  const turn = random() * Math.PI * 2;
  return [...files].sort(byWeight).map((file, rank) => {
    const reach = radius * Math.sqrt((rank + 0.5) / files.length) * (0.75 + random() * 0.5);
    const angle = turn + rank * 2.39996 + random() * 0.5;
    return {
      chapter: file.chapter,
      path: file.path,
      lines: file.lines,
      magnitude: most > 0 ? Math.log(file.lines + 1) / Math.log(most + 1) : 0,
      x: clamp(centre[0] + Math.cos(angle) * reach, EDGE, box.width - EDGE),
      y: clamp(centre[1] + Math.sin(angle) * reach * 0.8, EDGE, box.height - EDGE),
      fromX: random() * box.width,
      fromY: box.height * (0.1 + random() * 0.9),
      driftX: (random() - 0.5) * 7,
      driftY: -(6 + random() * 13),
      twinkle: random() * Math.PI * 2,
    };
  });
}

/** Prim's minimum spanning tree over `points`; edges as indexes into `points`. */
function spanningTree(points: { x: number; y: number }[]): [number, number][] {
  const edges: [number, number][] = [];
  const inTree = [0];
  while (inTree.length < points.length) {
    let best: [number, number, number] = [0, 0, Infinity];
    for (const from of inTree) {
      for (const [to, point] of points.entries()) {
        if (inTree.includes(to)) continue;
        const origin = points[from] ?? point;
        const length = Math.hypot(origin.x - point.x, origin.y - point.y);
        if (length < best[2]) best = [from, to, length];
      }
    }
    edges.push([best[0], best[1]]);
    inTree.push(best[1]);
  }
  return edges;
}

/**
 * The box a name takes: one line while it fits, then two at the widest a name
 * may be (the stylesheet clamps it there and ends a longer one in an
 * ellipsis). The count's line decides the width only when it is the longer.
 */
function nameBox(name: string, files: number, box: SkyBox): { width: number; height: number } {
  const widest = Math.min(NAME_WIDEST, box.width - EDGE * 2);
  const nameWidth = name.length * CHAR_WIDTH + 12;
  const width = Math.min(widest, Math.max(nameWidth, `${files} files`.length * CHAR_WIDTH + 12));
  const lines = nameWidth > width ? 2 : 1;
  return { width, height: NAME_HEIGHT + (lines - 1) * NAME_LINE };
}

/** Side by side with a gap between them, or one wholly above the other. */
function overlaps(a: SkyLabel, b: SkyLabel): boolean {
  const across = Math.abs(a.x - b.x) < (a.width + b.width) / 2 + NAME_GAP;
  return across && a.y < b.y + b.height && b.y < a.y + a.height;
}

interface Constellation {
  chapter: number;
  name: string;
  files: number;
  stars: number;
  centre: [number, number];
  radius: number;
}

/**
 * The largest chapters by stars get a name, under their cluster; a name that
 * would overlap one already placed is left off — the stars still say it — and
 * the next largest is asked instead, until `MOST_NAMES` are up.
 */
function names(constellations: Constellation[], box: SkyBox): SkyLabel[] {
  const placed: SkyLabel[] = [];
  const ranked = constellations
    .filter((one) => one.stars > 0)
    .sort((a, b) => b.stars - a.stars || a.chapter - b.chapter);
  for (const one of ranked) {
    if (placed.length === MOST_NAMES) break;
    const { width, height } = nameBox(one.name, one.files, box);
    const label = {
      chapter: one.chapter,
      name: one.name,
      files: one.files,
      width,
      height,
      x: clamp(one.centre[0], width / 2 + EDGE, box.width - width / 2 - EDGE),
      y: clamp(one.centre[1] + one.radius * 0.8 + 10, EDGE, box.height - height - EDGE),
    };
    if (!placed.some((other) => overlaps(label, other))) placed.push(label);
  }
  return placed.sort((a, b) => a.chapter - b.chapter);
}

/**
 * Stars, figures and names for `chapters` inside `box`. Seeded from the
 * chapter names and file paths, so the layout belongs to the review.
 */
export function layoutSky(chapters: readonly SkyChapter[], box: SkyBox): Sky {
  const seedText = chapters
    .map((c) => [c.name, ...c.files.map((f) => f.path)].join("\n"))
    .join("\n\n");
  const kept = keptFiles(chapters);
  const most = Math.max(0, ...kept.map((file) => file.lines));
  const scope = { box, random: seeded(seedOf(seedText)), most };
  const points = centres(chapters.length, box);
  const gap = closestGap(points, box);
  const stars: Star[] = [];
  const figures: [number, number][][] = [];
  const constellations: Constellation[] = [];
  for (const [chapter, { name, files }] of chapters.entries()) {
    const mine = kept.filter((file) => file.chapter === chapter);
    const centre = points[chapter] ?? [box.width / 2, box.height / 2];
    const spread = 24 + 11 * Math.sqrt(mine.length) * Math.min(1, box.width / 700);
    const radius = Math.min(gap * 0.42, spread);
    const placed = cluster(mine, centre, radius, scope);
    const offset = stars.length;
    stars.push(...placed);
    const tree = spanningTree(placed.slice(0, FIGURE_STARS));
    figures.push(tree.map(([a, b]) => [a + offset, b + offset]));
    constellations.push({
      chapter,
      name,
      files: files.length,
      stars: placed.length,
      centre,
      radius,
    });
  }
  return { box, stars, figures, labels: names(constellations, box) };
}
