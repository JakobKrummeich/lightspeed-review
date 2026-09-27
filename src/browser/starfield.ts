/**
 * The opening's sky: every file a star, every chapter a constellation. Pure
 * and seeded — no DOM, no clock, no `Math.random` — so the same review draws
 * the same sky on every reload. `dom/starfield-canvas.ts` paints it.
 */
import type { DiffGroup } from "../diff-extract.ts";
import { spanningTree } from "./sky-figure.ts";
import { clearCentre, keepOut, outOf, type SkyRect } from "./sky-keep-out.ts";
import {
  estimateName,
  placeNames,
  type MeasureName,
  type NameSite,
  type SkyLabel,
} from "./sky-names.ts";

export { estimateName, type MeasureName, type SkyLabel } from "./sky-names.ts";

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
  /**
   * `FAINTEST` (a file with no lines: a rename, a binary) to 1 (the largest
   * file in the review), on a log scale.
   */
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

/** The painter's 4 ms frame budget holds up to this many. */
export const MOST_STARS = 600;
/** Real constellations skip their faint stars: 40 files read as a cluster with a figure in it. */
export const FIGURE_STARS = 7;

/**
 * One clock for the painter and the overlay, in ms: gathering from the sky
 * sheet's arrival, the jump from the last press. The button waits after the
 * names so the chapters are looked at before they are left.
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
/** The dimmest a star gets: a file with no changed lines (a rename, a binary) still shows. */
const FAINTEST = 0.15;
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
 * Wraps round the sky, so a drifting field never empties. Written into `into`
 * when given, so the painter reuses one object per star every frame.
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
 * Chapter centres in review order: one in the middle, up to six along an arc,
 * more clockwise round a ring. Centred on the sky's middle.
 */
function centres(count: number, box: SkyBox): [number, number][] {
  // Spread across the whole width, three chapters read as strangers, not one sky.
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
  /** Kept clear for the button (`sky-keep-out.ts`). */
  keep: SkyRect;
}

/**
 * A cluster spirals out from its centre, biggest file in the middle (the
 * golden angle keeps the spiral from lining up). Stars and their drift are
 * both kept inside the sky, and the formed stars off the button's box.
 */
function cluster(files: Kept[], centre: [number, number], radius: number, scope: Scope): Star[] {
  const { box, random, most, keep } = scope;
  const turn = random() * Math.PI * 2;
  return [...files].sort(byWeight).map((file, rank) => {
    const reach = radius * Math.sqrt((rank + 0.5) / files.length) * (0.75 + random() * 0.5);
    const angle = turn + rank * 2.39996 + random() * 0.5;
    const at = outOf(keep, {
      x: centre[0] + Math.cos(angle) * reach,
      y: centre[1] + Math.sin(angle) * reach * 0.8,
    });
    return {
      chapter: file.chapter,
      path: file.path,
      lines: file.lines,
      magnitude:
        FAINTEST + (1 - FAINTEST) * (most > 0 ? Math.log(file.lines + 1) / Math.log(most + 1) : 0),
      x: clamp(at.x, EDGE, box.width - EDGE),
      y: clamp(at.y, EDGE, box.height - EDGE),
      fromX: random() * box.width,
      fromY: box.height * (0.1 + random() * 0.9),
      driftX: (random() - 0.5) * 7,
      driftY: -(6 + random() * 13),
      twinkle: random() * Math.PI * 2,
    };
  });
}

/**
 * Stars, figures and names for `chapters` inside `box`. Seeded from the
 * chapter names and file paths, so the layout belongs to the review. `measure`
 * gives each name's width as the page will set it; without one, a guess.
 */
export function layoutSky(
  chapters: readonly SkyChapter[],
  box: SkyBox,
  measure: MeasureName = estimateName,
): Sky {
  const seedText = chapters
    .map((c) => [c.name, ...c.files.map((f) => f.path)].join("\n"))
    .join("\n\n");
  const kept = keptFiles(chapters);
  const most = Math.max(0, ...kept.map((file) => file.lines));
  const keep = keepOut(box);
  const scope = { box, random: seeded(seedOf(seedText)), most, keep };
  const points = centres(chapters.length, box);
  const gap = closestGap(points, box);
  const stars: Star[] = [];
  const figures: [number, number][][] = [];
  const sites: NameSite[] = [];
  for (const [chapter, { name, files }] of chapters.entries()) {
    const mine = kept.filter((file) => file.chapter === chapter);
    const spread = 24 + 11 * Math.sqrt(mine.length) * Math.min(1, box.width / 700);
    const radius = Math.min(gap * 0.42, spread);
    // A star reaches out to 1.25 of the radius (`cluster`).
    const centre = clearCentre(
      points[chapter] ?? [box.width / 2, box.height / 2],
      radius * 1.25,
      keep,
    );
    const placed = cluster(mine, centre, radius, scope);
    const offset = stars.length;
    stars.push(...placed);
    const tree = spanningTree(placed.slice(0, FIGURE_STARS), keep);
    figures.push(tree.map(([a, b]) => [a + offset, b + offset]));
    sites.push({
      chapter,
      name,
      files: files.length,
      stars: placed.length,
      centre,
      radius,
      left: Math.min(...placed.map((star) => star.x)),
      right: Math.max(...placed.map((star) => star.x)),
      top: Math.min(...placed.map((star) => star.y)),
      bottom: Math.max(...placed.map((star) => star.y)),
    });
  }
  return { box, stars, figures, labels: placeNames(sites, box, measure, keep) };
}
