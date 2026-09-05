/**
 * What a tick changes without a redraw: checkboxes, counters, progress bar —
 * patched in place so diff2html output and folds survive every press. The
 * chapter index is deliberately absent: ticks happen inside chapters, the
 * index only on the overview, so there is never one on screen to patch.
 */
import type { DiffGroup } from "../../diff-extract.ts";
import {
  counterLabel,
  groupApproved,
  overallCounterLabel,
  toggleFileApproved,
  toggleGroupApproved,
} from "../diff-view.ts";
import { progressSegments, segmentFillStyle, segmentLabel } from "../progress-bar.ts";
import { fileBlock, groupSection } from "./diff-folds.ts";

/** Returns the new approved list for a checkbox change, or undefined if it was some other input. */
export function nextApproved(
  groups: DiffGroup[],
  approved: string[],
  input: HTMLInputElement,
): string[] | undefined {
  if (input.classList.contains("lsr-approved") && input.dataset.file) {
    return toggleFileApproved(approved, input.dataset.file, input.checked);
  }
  if (input.classList.contains("lsr-tick-all")) {
    const group = groups[Number(input.dataset.groupIndex)];
    if (group) return toggleGroupApproved(approved, group, input.checked);
  }
  return undefined;
}

/**
 * Patches checkboxes and counters in place: re-rendering would throw away
 * fold state and re-run diff2html per tick. Open/shut is not patched here;
 * it follows the flips in the tick handler.
 */
export function applyApprovedState(
  root: HTMLElement,
  groups: DiffGroup[],
  approved: string[],
): void {
  for (const [index, group] of groups.entries()) {
    const section = groupSection(root, index);
    if (!section) continue;
    setText(section, ".lsr-gate-counter", counterLabel(group, approved));
    setChecked(section, ".lsr-tick-all", groupApproved(group, approved));
    for (const file of group.files) {
      const block = fileBlock(section, file.path);
      if (!block) continue;
      setChecked(block, ".lsr-approved", approved.includes(file.path));
    }
  }
}

/**
 * Header bar and count: patched, not redrawn. A redraw hands segments new
 * elements, so the fill would jump instead of running to its width — the one
 * moment the bar is there to be watched.
 */
export function applyProgressState(
  progress: HTMLElement,
  groups: DiffGroup[],
  approved: string[],
): void {
  for (const [index, segment] of progressSegments(groups, approved).entries()) {
    const element = progress.querySelector<HTMLElement>(
      `.lsr-progress-segment[data-group-index="${index}"]`,
    );
    if (!element) continue;
    element.setAttribute("data-state", segment.state);
    const label = segmentLabel(segment);
    element.setAttribute("title", label);
    element.setAttribute("aria-label", label);
    const fill = element.querySelector<HTMLElement>(".lsr-progress-fill");
    // Whole style attribute: width is the fill's only inline property, and
    // writing it back matches the render.
    if (fill) fill.setAttribute("style", segmentFillStyle(segment));
  }
  setText(progress, ".lsr-progress-count", overallCounterLabel(groups, approved));
}

function setText(scope: HTMLElement, selector: string, text: string): void {
  const element = scope.querySelector(selector);
  if (element) element.textContent = text;
}

function setChecked(scope: HTMLElement, selector: string, checked: boolean): void {
  const input = scope.querySelector<HTMLInputElement>(selector);
  if (input) input.checked = checked;
}
