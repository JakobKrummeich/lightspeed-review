import type { DiffFile, DiffGroup } from "../diff-extract.ts";
import { escapeHtml } from "../escape-html.ts";
import { reviewPaths } from "../review-files.ts";
import { groupApproved, overallCounterLabel } from "./diff-view.ts";
import { groupIndexEntries, indexCounterLabel, type GroupIndexEntry } from "./group-index.ts";

/**
 * One group's standing plus its weight. Extends the index's entry: a second
 * reading of the same counts would be a second thing to keep in step with ticks.
 */
export interface ProgressSegment extends GroupIndexEntry {
  /**
   * Lines changed = bar width: reviews are read line by line, so one 400-line
   * file outweighs six one-line renames. Never equal widths per group — that
   * draws a review as done when the cheap half is.
   */
  weight: number;
  /** The same measure over the files that are ticked: what the fill is. */
  approvedWeight: number;
  state: SegmentState;
}

/**
 * Partial is its own state, not a fill width alone: at eight pixels tall a
 * sliver of fill is not something the eye reliably finds.
 */
export type SegmentState = "approved" | "partial" | "untouched";

/**
 * The bar's data, read from `groupIndexEntries` and `groupApproved` so
 * header, index and group counters cannot disagree.
 */
export function progressSegments(groups: DiffGroup[], approved: string[]): ProgressSegment[] {
  const entries = groupIndexEntries(groups, approved);
  return groups.map((group, index) => {
    const entry = entries[index]!;
    return {
      ...entry,
      weight: weightOf(group.files),
      approvedWeight: weightOf(group.files.filter((file) => approved.includes(file.path))),
      state: segmentState(groupApproved(group, approved), entry.approved),
    };
  });
}

function segmentState(allApproved: boolean, approvedFiles: number): SegmentState {
  if (allApproved) return "approved";
  return approvedFiles === 0 ? "untouched" : "partial";
}

/**
 * Reading cost. Floored at one line each: a zero-line file (binary, pure
 * rename) still needs a decision, and at zero would vanish from the bar.
 */
function weightOf(files: DiffFile[]): number {
  return files.reduce((total, file) => total + Math.max(1, file.insertions + file.deletions), 0);
}

/**
 * Segment fill as inline width, patchable on a tick without a bar redraw.
 * Empty group: no share (avoids division by zero).
 */
export function segmentFillStyle(segment: ProgressSegment): string {
  const share = segment.weight === 0 ? 0 : segment.approvedWeight / segment.weight;
  return `width: ${Math.round(share * 1000) / 10}%`;
}

/**
 * What the segment is, for a pointer resting on it and for a screen reader. A
 * swept chapter says so in words as well as in hatching: the hatch is the whole
 * of what the bar says about the tier, and a reviewer reading the bar through a
 * screen reader would otherwise be the one person it says nothing to.
 */
export function segmentLabel(segment: ProgressSegment): string {
  const counter = indexCounterLabel(segment);
  return segment.sweep ? `${segment.name}: ${counter}, mechanical` : `${segment.name}: ${counter}`;
}

/**
 * The share of the row a segment asks for. The square root of the lines it
 * changed, not the lines themselves: a 290-line rename beside a 31-line
 * decision took nine tenths of the bar and left the chapter worth reading a
 * sliver — the order of the two is the part worth drawing, not the ratio. The
 * root keeps the bigger chapter bigger and compresses the distance to about
 * three to one. Floored at one so a group of one file is still a press.
 */
export function segmentGrow(weight: number): number {
  return Math.round(Math.sqrt(Math.max(1, weight)) * 100) / 100;
}

/**
 * Header progress bar: one segment per group in reading order, width = lines
 * changed. Pure. The bar answers "how much is left" at a glance, the count
 * beside it exactly; neither replaces the other. No files: words only.
 */
export function renderProgressBar(groups: DiffGroup[], approved: string[], focus?: number): string {
  const count = `<span class="lsr-progress-count">${overallCounterLabel(groups, approved)}</span>`;
  if (reviewPaths(groups).size === 0) return count;
  const list = progressSegments(groups, approved);
  const segments = list
    .map((segment, index) => renderSegment(segment, index, index === focus))
    .join("");
  // `role="group"`, not `progressbar`: a progressbar's contents are
  // presentational, which would hide the per-group labels from screen readers.
  // The count rides along as a custom property: the segments' pressable floor
  // is capped at an equal share of the row, and only the markup knows how many
  // shares that is. Without it a review of thirty chapters overflows the header.
  return `<span class="lsr-progress-bar" role="group" aria-label="Approval by group" style="--lsr-progress-segments: ${list.length}">${segments}</span>${count}`;
}

/**
 * `flex-grow`, not percentage widths: segments share what the header row has
 * left, unmeasured. `data-current` marks the focused chapter; ticks patch
 * around it (`applyProgressState` never touches it) and chapter moves are
 * redraws. A button, not a picture: each segment is the fastest way into its
 * chapter, and `role="img"` would take the press away.
 *
 * `data-tier` is written once and never patched, because a tier is settled for
 * the whole round before the bar is first drawn: what a tick changes is how
 * much of a chapter is read, never whether it was worth reading. It is an
 * attribute rather than a second class so that the bar stays one kind of thing
 * on the page — the hatch is a state of a segment, like `data-state`.
 */
function renderSegment(segment: ProgressSegment, index: number, current: boolean): string {
  const label = escapeHtml(segmentLabel(segment));
  const mark = current ? ` data-current="true"` : "";
  const tier = segment.sweep ? ` data-tier="sweep"` : "";
  return `<button type="button" class="lsr-progress-segment" data-group-index="${index}" data-state="${segment.state}"${tier}${mark} style="flex-grow: ${segmentGrow(segment.weight)}" aria-label="${label}" title="${label}"><span class="lsr-progress-fill" style="${segmentFillStyle(segment)}"></span></button>`;
}
