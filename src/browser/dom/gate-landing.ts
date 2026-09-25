import type { DiffGroup } from "../../diff-extract.ts";
import { fileToResumeAt } from "../focus-mode.ts";
import { fileBlock, isExpanded, switchSection } from "./diff-folds.ts";

/** A press through a chapter's gate, and where it lands. */

export function gatePressOf(target: HTMLElement): HTMLElement | undefined {
  if (target.classList.contains("lsr-gate-press")) return target;
  if (!target.classList.contains("lsr-group")) return undefined;
  return target.querySelector<HTMLElement>(".lsr-gate-press") ?? undefined;
}

interface Reading {
  groups: DiffGroup[];
  approved: string[];
  focus: number | undefined;
}

/**
 * The element to scroll to the top once the gate is open: the chapter's first
 * file still to read when files above it are approved already, so a return
 * visit does not start by scrolling past what was read; otherwise the top of
 * the chapter, where reading starts. Scrolled to `start`, not centred like a
 * jump: the file's row is sticky under the focus bar, so it stays in sight,
 * and centring a long file would land mid-diff. The file is unfolded on the
 * way, since a reviewer may have shut it on an earlier visit: call this before
 * the gate's open report, so the report carries the unfolded file too.
 */
export function gateLanding(root: HTMLElement, reading: Reading): HTMLElement {
  const group = reading.focus === undefined ? undefined : reading.groups[reading.focus];
  const path = group && fileToResumeAt(group, reading.approved);
  const block = path === undefined ? null : fileBlock(root, path);
  if (!block) return root;
  const header = block.querySelector<HTMLElement>(".lsr-file-header");
  // Switched, not folded: the chapter appears around it in the same moment,
  // so there is no landmark on screen for a fold's animation to hold still.
  if (header && !isExpanded(header)) switchSection(header, true);
  return block;
}
