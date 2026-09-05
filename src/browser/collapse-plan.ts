import type { FileApprovalFlip, GroupApprovalFlip } from "./diff-view.ts";

/** One collapsible block of the review, named the way the page can find it again. */
export type FoldTarget = { kind: "group"; index: number } | { kind: "file"; path: string };

/**
 * Everything open in one draw. A whole state, not departures from the default:
 * "not listed" would mean different things per list, and the draw has already
 * resolved both.
 */
export interface OpenFolds {
  groups: number[];
  files: string[];
}

/** One block to open or shut as part of a single gesture. */
export interface FoldStep {
  target: FoldTarget;
  expanded: boolean;
  /** Worth watching: false for a block folding inside another folding block. */
  animated: boolean;
}

/** What one tick does to what is open, and what must not move while it happens. */
export interface CollapsePlan {
  steps: FoldStep[];
  /** Block held still in viewport; undefined when the tick moved nothing. */
  anchor: FoldTarget | undefined;
}

/**
 * What a tick folds, in apply order, and what the eye keeps. Anchor is the
 * outermost thing the gesture leaves standing (group over file). Only the
 * outermost fold animates: animating a file inside a group already folding
 * over it reads as two jolts for one press, so the inner one snaps shut where
 * nobody can see it.
 */
export function tickCollapsePlan(
  fileFlips: FileApprovalFlip[],
  groupFlips: GroupApprovalFlip[],
): CollapsePlan {
  const groups: FoldStep[] = groupFlips.map((flip) => ({
    target: { kind: "group", index: flip.index },
    expanded: !flip.approved,
    animated: true,
  }));
  const files: FoldStep[] = fileFlips.map((flip) => ({
    target: { kind: "file", path: flip.path },
    expanded: !flip.approved,
    animated: groups.length === 0,
  }));
  // Files first: a group opening around already-settled files has one height
  // to animate towards, not two.
  return { steps: [...files, ...groups], anchor: groups[0]?.target ?? files[0]?.target };
}
