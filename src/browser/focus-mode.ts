import type { DiffFile, DiffGroup } from "../diff-extract.ts";
import { escapeHtml } from "../escape-html.ts";
import { relocationOf, unchangedRelocationOf } from "../file-relocation.ts";
import { isSweep } from "../group-tier.ts";
import { filesLabel, groupIndexEntries, groupSize, linesLabel } from "./group-index.ts";
import { pathLabel } from "./path-label.ts";

/** The pure half of focus mode; the mount decides when to draw these. */

/**
 * A re-group renumbers the chapters and a stored record can be corrupt, so
 * anything but an index this review actually has reads as no focus at all —
 * the overview, never an empty chapter.
 */
export function clampFocus(focus: number | undefined, count: number): number | undefined {
  if (focus === undefined || !Number.isInteger(focus)) return undefined;
  return focus >= 0 && focus < count ? focus : undefined;
}

/**
 * Wraps round to the start, so approving chapter after chapter never needs a
 * press between them. Sweep chapters are landed on like any other: every card
 * offers its tick, so a sweep is a press on its card and not a reading.
 * Undefined when nothing is left: the finished card stays, mark and all.
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
 * The name is rendered on every draw and shown by the stylesheet only while
 * the diff is up: on the card it is right below in the title size, and once
 * the card is gone behind the diff the bar is the only place left to say
 * which chapter this is. Buttons, not links, because every one of them
 * redraws in place. The ends are disabled rather than dropped so the two
 * controls keep their positions under the pointer from chapter to chapter.
 */
export function renderFocusBar(groups: DiffGroup[], focus: number): string {
  const group = groups[focus];
  if (group === undefined) return "";
  const last = groups.length - 1;
  return `<div class="lsr-focus-bar">
  <button type="button" class="lsr-focus-exit">‹ All chapters</button>
  <span class="lsr-focus-name">${escapeHtml(group.name)}</span>
  <span class="lsr-focus-count">Chapter ${focus + 1} of ${groups.length}</span>
  <button type="button" class="lsr-focus-prev"${focus === 0 ? " disabled" : ""}>Previous</button>
  <button type="button" class="lsr-focus-next"${focus === last ? " disabled" : ""}>Next</button>
</div>`;
}

export interface ChapterGate {
  group: DiffGroup;
  contentId: string;
  /** Counted in `diff-view`, so every counter in the review has one source. */
  counter: string;
}

/**
 * Stands alone because the same sentence once headed the first file's diff,
 * where the eye went to the code and the intent was never read — a screen
 * with nothing else on it is the only place a reason gets read before the
 * lines it is about. Nothing here is muted for the same reason: on this
 * screen quiet type would only say "skip me".
 */
export function renderChapterGate({ group, contentId, counter }: ChapterGate): string {
  return `<div class="lsr-gate">
    <h2 class="lsr-gate-name">${escapeHtml(group.name)}</h2>${tierLine(group)}
    <p class="lsr-gate-rationale">${escapeHtml(group.rationale)}</p>
    <details class="lsr-gate-files">
      <summary class="lsr-gate-files-summary">${filesSummary(group)}</summary>
      <ul class="lsr-gate-files-list">
        ${group.files.map(gateFile).join("\n        ")}
      </ul>
    </details>
    <p class="lsr-gate-counter">${counter}</p>
    <button type="button" class="lsr-gate-press" aria-expanded="false" aria-controls="${contentId}">Read the diff</button>
  </div>`;
}

/**
 * The survey's own words for its lane, said again on the one card that can be
 * reached without passing through the lane. Nothing on a study chapter's
 * card: reading is the default and needs no label.
 */
function tierLine(group: DiffGroup): string {
  if (!isSweep(group)) return "";
  return `\n    <p class="lsr-gate-tier">Mechanical — nothing to decide</p>`;
}

/**
 * Folded behind a `<details>`, so the keyboard and the screen reader get the
 * fold for free and no press of the mount's is needed to work it: the count
 * and the size are what a card is read for at a glance; the paths are for the
 * reviewer checking the rationale against them, one press away.
 */
function filesSummary(group: DiffGroup): string {
  const { files, insertions, deletions } = groupSize(group);
  return `${filesLabel(files)} · ${linesLabel(insertions, deletions)}`;
}

/**
 * The list is what makes the rationale checkable: these paths and these many
 * lines are the whole of what the press opens, so a rationale that describes
 * something else is caught before the diff is read rather than after. A
 * relocated file shows both of its paths and the word for it: `src/new/thing.ts
 * +0 −0` read as a file nobody touched, when the move was the change.
 */
function gateFile(file: DiffFile): string {
  return `<li class="lsr-gate-file"><span class="lsr-gate-path">${pathLabel(file)}</span><span class="lsr-gate-lines">${sizeLabel(file)}</span></li>`;
}

function sizeLabel(file: DiffFile): string {
  const lines = linesLabel(file.insertions, file.deletions);
  const relocation = relocationOf(file);
  if (relocation === undefined) return lines;
  return unchangedRelocationOf(file) === undefined ? `${relocation} · ${lines}` : relocation;
}
