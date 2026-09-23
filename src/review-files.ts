import type { DiffGroup } from "./diff-extract.ts";
import { isSweep } from "./group-tier.ts";

/**
 * Browser counters, the compose-box sentence and the server's approval account
 * all ask this, so they cannot disagree about what "the whole review" is.
 */
export function reviewPaths(groups: DiffGroup[]): Set<string> {
  return new Set(groups.flatMap((group) => group.files.map((file) => file.path)));
}

export interface ApprovalPaths {
  /** In the review's own order. */
  approved: string[];
  /** Same order. */
  unapproved: string[];
  /** A subset of `approved`. */
  swept: string[];
  /** Distinct files in the review, so nobody sums the lists. */
  total: number;
}

/**
 * Approvals are intersected with the grouping's own paths: a tick left behind
 * by a file the last round dropped counts for nothing, and `approved` can never
 * exceed `total`.
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
 * A path a chapter to study also lists was put in front of the reviewer, so it
 * is not swept however many lanes repeat it — the same one-directional caution
 * that lets a tier be raised and never lowered.
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
