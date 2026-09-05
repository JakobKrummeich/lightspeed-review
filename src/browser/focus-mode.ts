import type { DiffFile, DiffGroup } from "../diff-extract.ts";
import { escapeHtml } from "../escape-html.ts";
import { isSweep } from "../group-tier.ts";
import { groupIndexEntries } from "./group-index.ts";

/**
 * Focus mode: one chapter of the review filling the viewport, the others not
 * rendered at all. Not hidden — absent: a big review is slow exactly because
 * every diff of every chapter is in the DOM, and hiding them would keep that
 * cost. This module is the pure half: which chapter may be focused, the bar
 * that says so, and the gate the chapter opens behind; the mount decides when
 * to draw them.
 */

/**
 * A held or stored chapter index, judged against the groups on screen now. A
 * re-group renumbers the chapters and a stored record can be corrupt, so
 * anything but an index this review actually has reads as no focus at all —
 * the overview, never an empty chapter.
 */
export function clampFocus(focus: number | undefined, count: number): number | undefined {
  if (focus === undefined || !Number.isInteger(focus)) return undefined;
  return focus >= 0 && focus < count ? focus : undefined;
}

/**
 * Where a reviewer goes once the chapter at `from` is finished: the next one in
 * reading order with something still unticked in it, wrapping round to the
 * start, so approving chapter after chapter never needs a press between them.
 * Sweep chapters are landed on like any other: the reviewer settles every
 * chapter in order, and every card offers its tick, so a sweep is a press on
 * its card and not a reading. Undefined when nothing is left: the finished
 * card stays, mark and all.
 */
export function nextChapterToRead(
  groups: DiffGroup[],
  approved: string[],
  from: number,
): number | undefined {
  const entries = groupIndexEntries(groups, approved);
  for (let step = 1; step < groups.length; step++) {
    const index = (from + step) % groups.length;
    const entry = entries[index]!;
    if (entry.approved < entry.files) return index;
  }
  return undefined;
}

/**
 * The bar above a focused chapter: the way back to the overview, the
 * chapter's place, and the way to its neighbours. Not the chapter's name —
 * that is on the card right below, in the title size, and said again up here
 * it was the one thing on the screen written twice. Buttons, not links,
 * because every one of them redraws in place. The ends are disabled rather
 * than dropped so the two controls keep their positions under the pointer
 * from chapter to chapter.
 */
export function renderFocusBar(groups: DiffGroup[], focus: number): string {
  if (groups[focus] === undefined) return "";
  const last = groups.length - 1;
  return `<div class="lsr-focus-bar">
  <button type="button" class="lsr-focus-exit">‹ All chapters</button>
  <span class="lsr-focus-count">Chapter ${focus + 1} of ${groups.length}</span>
  <button type="button" class="lsr-focus-prev"${focus === 0 ? " disabled" : ""}>Previous</button>
  <button type="button" class="lsr-focus-next"${focus === last ? " disabled" : ""}>Next</button>
</div>`;
}

/** A chapter's gate: what it says, and the region one press of it reveals. */
export interface ChapterGate {
  group: DiffGroup;
  /** The group's content element, named so the press can say what it opens. */
  contentId: string;
  /**
   * How far the chapter is approved, counted in `diff-view` so this line and
   * every other counter in the review are one sentence with one source.
   */
  counter: string;
}

/**
 * The card a chapter opens behind: its name, the one sentence the grouping
 * wrote about it, what is in it, and the one press that shows the diff. It
 * stands alone because the same sentence used to head the first file's diff,
 * where the eye went to the code and the intent was never read — a screen with
 * nothing else on it is the only place a reason gets read before the lines it
 * is about. Nothing here is muted for the same reason: on this screen quiet
 * type would only say "skip me".
 */
export function renderChapterGate({ group, contentId, counter }: ChapterGate): string {
  return `<div class="lsr-gate">
    <h2 class="lsr-gate-name">${escapeHtml(group.name)}</h2>${tierLine(group)}
    <p class="lsr-gate-rationale">${escapeHtml(group.rationale)}</p>
    <ul class="lsr-gate-files">
      ${group.files.map(gateFile).join("\n      ")}
    </ul>
    <p class="lsr-gate-counter">${counter}</p>
    <button type="button" class="lsr-gate-press" aria-expanded="false" aria-controls="${contentId}">Read the diff</button>
  </div>`;
}

/**
 * Why a sweep chapter's tick is the press to make without reading first: the
 * survey's own words for its lane, said again on the one card that can be
 * reached without passing through the lane. Nothing on a study chapter's card,
 * because reading is the default and needs no label.
 */
function tierLine(group: DiffGroup): string {
  if (!isSweep(group)) return "";
  return `\n    <p class="lsr-gate-tier">Mechanical — nothing to decide</p>`;
}

/**
 * One file of the chapter with the size of its change. The list is what makes
 * the rationale checkable: these paths and these many lines are the whole of
 * what the press opens, so a rationale that describes something else is caught
 * before the diff is read rather than after.
 */
function gateFile(file: DiffFile): string {
  return `<li class="lsr-gate-file"><span class="lsr-gate-path">${escapeHtml(file.path)}</span><span class="lsr-gate-lines">+${file.insertions} −${file.deletions}</span></li>`;
}
