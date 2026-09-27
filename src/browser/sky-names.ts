/**
 * Where each chapter's name stands on the sky. Every chapter with a star gets
 * one: first a spot hugging its figure, then the nearest free spot on a grid
 * over the whole sky. Names never overlap each other or the button's box, and
 * keep off other chapters' stars while there is room to.
 */
import { coversRect, type SkyRect } from "./sky-keep-out.ts";

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

/** A chapter's figure as the names see it: the box its placed stars span. */
export interface NameSite {
  chapter: number;
  name: string;
  files: number;
  stars: number;
  centre: [number, number];
  radius: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Size {
  width: number;
  height: number;
}

/**
 * The width `text` takes on one line in the names' own font, px. The page
 * measures it (`opening-sky.ts`); the layout stays pure and only asks.
 */
export type MeasureName = (text: string) => number;

const EDGE = 12;
/** A one-line name and its count, px; each further line of the name adds `NAME_LINE`. */
const NAME_HEIGHT = 38;
const NAME_LINE = 18;
const NAME_GAP = 6;
/** The widest a name may be; a longer one takes a second line, then an ellipsis. */
const NAME_WIDEST = 240;
/** A bold meta-size Latin character, generously; only for when nothing can measure. */
const CHAR_WIDTH = 9;
/** Room round a measured name, px: subpixel rounding and the glow of its shadow. */
const NAME_SLACK = 12;
/** Between a name and its own stars. */
const NAME_OFFSET = 10;
/** The grid the fallback search walks, px. */
const STEP = 12;
/** How far from its stars a name may go to keep off another chapter's. */
const REACH = 48;

/** Without a canvas to measure in: a Latin guess — CJK and wide letters run over it. */
export function estimateName(text: string): number {
  return text.length * CHAR_WIDTH;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * One line while it fits, then two at the widest a name may be (the
 * stylesheet ends a longer one in an ellipsis). The count's line decides the
 * width only when it is the longer.
 */
function nameSize(site: NameSite, box: Size, measure: MeasureName): Size {
  const widest = Math.min(NAME_WIDEST, box.width - EDGE * 2);
  const nameWidth = measure(site.name) + NAME_SLACK;
  const countWidth = estimateName(`${site.files} files`) + NAME_SLACK;
  const width = Math.min(widest, Math.max(nameWidth, countWidth));
  const lines = nameWidth > width ? 2 : 1;
  return { width, height: NAME_HEIGHT + (lines - 1) * NAME_LINE };
}

interface Room {
  box: Size;
  keep: SkyRect;
  /** Every figure's box, the names keep off while they can. */
  figures: SkyRect[];
  placed: SkyLabel[];
}

function figureOf(site: NameSite): SkyRect {
  const pad = 4;
  return {
    x: site.left - pad,
    y: site.top - pad,
    width: site.right - site.left + pad * 2,
    height: site.bottom - site.top + pad * 2,
  };
}

function labelAt(site: NameSite, size: Size, box: Size, [x, y]: [number, number]): SkyLabel {
  return {
    chapter: site.chapter,
    name: site.name,
    files: site.files,
    ...size,
    x: clamp(x, size.width / 2 + EDGE, box.width - size.width / 2 - EDGE),
    y: clamp(y, EDGE, box.height - size.height - EDGE),
  };
}

/**
 * Under the figure, then over it, then beside it; a name that would cover the
 * button stands at the side of the button's box instead, still under or over.
 */
function hugging(site: NameSite, size: Size, keep: SkyRect, box: Size): [number, number][] {
  const [x, y] = site.centre;
  const under = Math.max(y + site.radius * 0.8, site.bottom) + NAME_OFFSET;
  const over = Math.min(y - site.radius * 0.8, site.top) - NAME_OFFSET - size.height;
  const middle = (site.top + site.bottom - size.height) / 2;
  const aside = x < box.width / 2 ? keep.x - size.width / 2 : keep.x + keep.width + size.width / 2;
  return [
    [x, under],
    [aside, under],
    [x, over],
    [aside, over],
    [site.left - NAME_OFFSET - size.width / 2, middle],
    [site.right + NAME_OFFSET + size.width / 2, middle],
  ];
}

/** How far a name's box stands from a figure's box; 0 when they touch. */
function apart(label: SkyLabel, figure: SkyRect): number {
  const dx = Math.max(
    0,
    figure.x - label.x - label.width / 2,
    label.x - label.width / 2 - figure.x - figure.width,
  );
  const dy = Math.max(0, figure.y - label.y - label.height, label.y - figure.y - figure.height);
  return Math.hypot(dx, dy);
}

/** Every spot on the grid, nearest the figure first. */
function grid(site: NameSite, size: Size, box: Size): SkyLabel[] {
  const figure = figureOf(site);
  const spots: [SkyLabel, number][] = [];
  for (let y = EDGE; y + size.height + EDGE <= box.height; y += STEP) {
    for (let x = EDGE + size.width / 2; x + size.width / 2 + EDGE <= box.width; x += STEP) {
      const label = labelAt(site, size, box, [x, y]);
      spots.push([label, apart(label, figure)]);
    }
  }
  return spots.sort((a, b) => a[1] - b[1]).map(([label]) => label);
}

function overlaps(a: SkyLabel, b: SkyLabel): boolean {
  const across = Math.abs(a.x - b.x) < (a.width + b.width) / 2 + NAME_GAP;
  return across && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Off the button and every placed name. */
function free(label: SkyLabel, room: Room): boolean {
  return !coversRect(room.keep, label) && !room.placed.some((other) => overlaps(label, other));
}

/** Free, and off every figure's stars. */
function clear(label: SkyLabel, room: Room): boolean {
  return free(label, room) && !room.figures.some((figure) => coversRect(figure, label));
}

/**
 * Near its figure, the first spot clear of everything; else the first near
 * one that at least overlaps no name; else the nearest free spot anywhere;
 * else — nothing free left at all — under its figure, shown all the same.
 */
function spotFor(site: NameSite, size: Size, room: Room): SkyLabel {
  const figure = figureOf(site);
  const close = (label: SkyLabel): boolean => apart(label, figure) <= REACH;
  const near = hugging(site, size, room.keep, room.box).map((at) =>
    labelAt(site, size, room.box, at),
  );
  const quick = near.find((label) => close(label) && clear(label, room));
  if (quick) return quick;
  const all = [...near, ...grid(site, size, room.box)];
  return (
    all.find((label) => close(label) && clear(label, room)) ??
    all.find((label) => close(label) && free(label, room)) ??
    all.find((label) => free(label, room)) ??
    near[0]!
  );
}

/**
 * Names for every chapter with a star, largest first, so the big figures get
 * the spots hugging them; returned in chapter order.
 */
export function placeNames(
  sites: readonly NameSite[],
  box: Size,
  measure: MeasureName,
  keep: SkyRect,
): SkyLabel[] {
  const named = sites.filter((site) => site.stars > 0);
  const room: Room = { box, keep, figures: named.map(figureOf), placed: [] };
  const ranked = [...named].sort((a, b) => b.stars - a.stars || a.chapter - b.chapter);
  for (const site of ranked) room.placed.push(spotFor(site, nameSize(site, box, measure), room));
  return [...room.placed].sort((a, b) => a.chapter - b.chapter);
}
