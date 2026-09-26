/**
 * 06 Tab beacon: a reviewer who left for another tab while the agent worked
 * is told from the tab strip that the turn came back to them — the title
 * says so and the favicon lights. Pure: what the tab should say, never how it
 * is written (`dom/tab-beacon-mount.ts`).
 */
import type { Turn } from "../session-store.ts";

export type Beacon = "dark" | "lit";

/**
 * Lit only on the reviewer's turn in a tab nobody is looking at: a visible
 * tab has the page itself to say whose turn it is.
 */
export function beaconState(turn: Turn, hidden: boolean): Beacon {
  return hidden && turn.holder === "reviewer" ? "lit" : "dark";
}

export const BEACON_PREFIX = "● Your turn · ";

/** In front, so it survives a tab strip that cuts the title short. */
export function beaconTitle(title: string, beacon: Beacon): string {
  return beacon === "lit" ? `${BEACON_PREFIX}${title}` : title;
}

/*
 * The mark: a cobalt tile with a four-point spark. A favicon is drawn by the
 * browser's chrome, outside the page and its stylesheet, so it cannot read a
 * token: these are the light scheme's accent and on-accent from
 * `css/tokens.css`, written out — the one place colour is spelled outside it.
 */
const COBALT = "#366bd3";
const SPARK = "#f7f8fc";
const TILE = `<rect width="32" height="32" rx="8" fill="${COBALT}"/>`;
const STAR = `<path d="M16 5c1 8 3 10 11 11-8 1-10 3-11 11-1-8-3-10-11-11 8-1 10-3 11-11z" fill="${SPARK}"/>`;

/** Lit: a halo behind the spark, and a second spark in the corner that twinkles between frames. */
function litMark(halo: number, corner: number): string {
  const glow = `<circle cx="16" cy="16" r="${halo}" fill="${SPARK}" opacity=".3"/>`;
  const dot = `<circle cx="26" cy="6" r="${corner}" fill="${SPARK}"/>`;
  return `${TILE}${glow}${STAR}${dot}`;
}

function iconUri(mark: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${mark}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const FAVICON = iconUri(`${TILE}${STAR}`);

/** Two frames, alternated while lit; the first is the one that stands still. */
export const FAVICON_LIT: readonly [string, string] = [
  iconUri(litMark(11, 4.5)),
  iconUri(litMark(8, 2.5)),
];
