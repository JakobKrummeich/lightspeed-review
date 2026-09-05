import type { DiffGroup } from "./diff-extract.ts";
import { isSweep } from "./group-tier.ts";

/**
 * Every path the review is made of, counted once however many groups list it.
 * Browser counters, the compose-box sentence and the server's approval account
 * all ask this, so they cannot disagree about what "the whole review" is.
 * Kept out of `src/browser/dom/`: that half is typed against lib.dom and
 * bundled for the page, and nothing outside it may import from it
 * (`eslint.config.js` enforces that).
 */
export function reviewPaths(groups: DiffGroup[]): Set<string> {
  return new Set(groups.flatMap((group) => group.files.map((file) => file.path)));
}

/** Where every file of a review stands at the moment it is asked. */
export interface ApprovalPaths {
  /** Ticked approved, in the review's own order. */
  approved: string[];
  /** The rest: the files nobody signed off on, same order. */
  unapproved: string[];
  /** The approvals a sweep lane took in one press — a subset of `approved`. */
  swept: string[];
  /** Distinct files in the review, so nobody sums the lists. */
  total: number;
}

/**
 * One account of the review, so no two callers can disagree about it. Approvals
 * are intersected with the grouping's own paths: a tick left behind by a file
 * the last round dropped counts for nothing, and `approved` can never exceed
 * `total`.
 */
export function approvalPaths(groups: DiffGroup[], approved: string[]): ApprovalPaths {
  const paths = [...reviewPaths(groups)];
  const ticked = (path: string) => approved.includes(path);
  const swept = sweptPaths(groups);
  return {
    approved: paths.filter(ticked),
    unapproved: paths.filter((path) => !ticked(path)),
    swept: paths.filter((path) => ticked(path) && swept.has(path)),
    total: paths.length,
  };
}

/**
 * The paths the review never asked anyone to read: those held by `sweep`
 * chapters alone. A path a chapter to study also lists was put in front of the
 * reviewer, so it is not swept however many lanes repeat it — the same
 * one-directional caution that lets a tier be raised and never lowered.
 */
export function sweptPaths(groups: DiffGroup[]): Set<string> {
  const swept = new Set<string>();
  for (const group of groups.filter(isSweep)) {
    for (const file of group.files) swept.add(file.path);
  }
  for (const group of groups.filter((group) => !isSweep(group))) {
    for (const file of group.files) swept.delete(file.path);
  }
  return swept;
}
