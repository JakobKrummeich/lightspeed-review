import type { FileApprovalFlip, GroupApprovalFlip } from "./diff-view.ts";

export type FoldTarget = { kind: "group"; index: number } | { kind: "file"; path: string };

/**
 * A whole state, not departures from the default: "not listed" would mean
 * different things per list, and the draw has already resolved both.
 */
export interface OpenFolds {
  groups: number[];
  files: string[];
}

export interface FoldStep {
  target: FoldTarget;
  expanded: boolean;
  animated: boolean;
}

export interface CollapsePlan {
  steps: FoldStep[];
  /** Held still in the viewport. */
  anchor: FoldTarget | undefined;
}

/**
 * Anchor is the outermost thing the gesture leaves standing (group over file).
 * Only the outermost fold animates: a file animating inside a group already
 * folding over it reads as two jolts for one press, so the inner one snaps
 * shut where nobody can see it.
 *
 * A group folds only on the tick that finishes it; the untick moves it nowhere.
 * An untick is a withdrawal, not a request to read, and it is made on the
 * chapter's card as often as under its lines — a card that opened on it would
 * look as if it had taken the press meant for the tick. The files inside do
 * open again, behind whatever the chapter is.
 */
export function tickCollapsePlan(
  fileFlips: FileApprovalFlip[],
  groupFlips: GroupApprovalFlip[],
): CollapsePlan {
  const groups: FoldStep[] = groupFlips
    .filter((flip) => flip.approved)
    .map((flip) => ({
      target: { kind: "group", index: flip.index },
      expanded: false,
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
