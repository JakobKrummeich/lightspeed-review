import type { DiffGroup } from "../diff-extract.ts";
import { escapeHtml } from "../escape-html.ts";
import { isSweep } from "../group-tier.ts";
import { LOGIC_BADGE_LABEL, heaviestGroups } from "./hunk-complexity.ts";

/**
 * Not what the group is for — that is the chapter's own gate. A clamped grey
 * copy of the rationale here was a line nobody read: either the reviewer
 * should read it, and then it must be set as though they should, or they
 * should not, and then it has no business on the page.
 */
export interface GroupIndexEntry {
  name: string;
  files: number;
  insertions: number;
  deletions: number;
  approved: number;
  densestLogic: boolean;
  /** Read off the chapter's tier and nothing else (`isSweep`): a chapter that never said says nothing here either. */
  sweep: boolean;
}

export function groupIndexEntries(groups: DiffGroup[], approved: string[]): GroupIndexEntry[] {
  const densest = heaviestGroups(groups);
  return groups.map((group, index) => ({
    name: group.name,
    ...groupSize(group),
    approved: group.files.filter((file) => approved.includes(file.path)).length,
    densestLogic: densest.includes(index),
    sweep: isSweep(group),
  }));
}

export function groupSize(
  group: DiffGroup,
): Pick<GroupIndexEntry, "files" | "insertions" | "deletions"> {
  return {
    files: group.files.length,
    insertions: sum(group, (file) => file.insertions),
    deletions: sum(group, (file) => file.deletions),
  };
}

export function indexCounterLabel(entry: GroupIndexEntry): string {
  return approvedLabel(entry.approved, entry.files);
}

/** Shared by the index, group counters and header bar: one sentence, everywhere. */
export function approvedLabel(done: number, total: number): string {
  return `${done}/${total} approved`;
}

export function indexFilesLabel(entry: GroupIndexEntry): string {
  return filesLabel(entry.files);
}

export function filesLabel(files: number): string {
  return `${files} file${files === 1 ? "" : "s"}`;
}

export function linesLabel(insertions: number, deletions: number): string {
  return `+${insertions} −${deletions}`;
}

/**
 * A union and never a toggle — the same press twice is the same list, where a
 * toggle's second press would untick a lane of twenty-seven files the reviewer
 * had already dealt with. The list goes down the same POST as every other tick.
 */
export function sweepApproved(groups: DiffGroup[], approved: string[]): string[] {
  const swept = groups
    .filter(isSweep)
    .flatMap((group) => group.files.map((file) => file.path))
    .filter((path) => !approved.includes(path));
  return [...approved, ...swept];
}

interface IndexRow {
  entry: GroupIndexEntry;
  index: number;
}

/**
 * Pure (assertable without a DOM). Entries are buttons, not links: they expand
 * the group too, and a fragment link would land on a collapsed heading. Plain
 * list: reading order is the reviewer's call — unless there is no order to
 * call, and then the one studied chapter is `sole` (see `renderEntry`). The
 * lane is absent rather than empty: a heading saying "0 files, nothing to
 * decide" is a thing to read on a screen built to be read in one look.
 *
 * The split moves nothing: `trailSweeps` (`src/group-tier.ts`) has already put
 * the swept chapters at the end of the array. Ordering here instead would
 * break the one number every surface names a chapter by — `data-group-index`
 * is a position in `groups`, shared with the header bar and the chapter on screen.
 */
export function renderGroupIndex(groups: DiffGroup[], approved: string[]): string {
  if (groups.length === 0) return "";
  const rows = groupIndexEntries(groups, approved).map((entry, index) => ({ entry, index }));
  const study = rows.filter(({ entry }) => !entry.sweep);
  const swept = rows.filter(({ entry }) => entry.sweep);
  const sole = rows.length === 1 && study.length === 1;
  return `<nav class="lsr-index" aria-label="Groups in this review">
  ${study.length === 0 ? "" : renderList(study, sole)}
  ${swept.length === 0 ? "" : renderLane(swept)}
</nav>`;
}

function renderList(rows: IndexRow[], sole = false): string {
  const items = rows.map(({ entry, index }) => renderEntry(entry, index, sole)).join("\n    ");
  return `<ol class="lsr-index-list">
    ${items}
  </ol>`;
}

/**
 * The chapters inside are the same pressable rows as above — a swept chapter
 * is still a chapter, and a reviewer who wants to see what moved must be able
 * to open it — so the lane changes where they are read, never whether they can
 * be. The one press is the point: facing 41 files, a reviewer approves most on
 * autopilot because every file costs the same tick; here 27 of them cost one.
 */
function renderLane(rows: IndexRow[]): string {
  const files = rows.reduce((total, { entry }) => total + entry.files, 0);
  return `<section class="lsr-sweep">
    <h2 class="lsr-sweep-heading">Mechanical — ${filesLabel(files)}, nothing to decide</h2>
    ${renderList(rows)}
    <button type="button" class="lsr-sweep-approve">Approve ${filesLabel(files)}</button>
  </section>`;
}

/**
 * The row ends on its way in said in words: a name over three counts, alone on
 * the screen, read as a heading over a diff that was missing, and a reviewer
 * facing one "All Changes" took the review for empty. The arrow is drawn for
 * the eye only; a screen reader already hears a button.
 *
 * `sole` is the review with nothing to choose between — one chapter, and one
 * to study. The survey is then only a step on the way to the diff, so the row
 * says what it opens and its label is drawn as the screen's one primary press.
 * A lone swept chapter is not sole: its lane's approve is that press already,
 * and two calls on one screen would be none.
 */
function renderEntry(entry: GroupIndexEntry, index: number, sole: boolean): string {
  return `<li class="lsr-index-item">
      <button type="button" class="lsr-index-entry" data-group-index="${index}"${sole ? " data-sole" : ""}>
        <span class="lsr-index-name">${escapeHtml(entry.name)}</span>
        <span class="lsr-index-files">${indexFilesLabel(entry)}</span>
        <span class="lsr-index-lines">${linesLabel(entry.insertions, entry.deletions)}</span>
        <span class="lsr-index-counter">${indexCounterLabel(entry)}</span>
        <span class="lsr-index-logic"${entry.densestLogic ? "" : " hidden"}>${LOGIC_BADGE_LABEL}</span>
        <span class="lsr-index-open">${sole ? "Open the chapter" : "Open"}<span aria-hidden="true">→</span></span>
      </button>
    </li>`;
}

function sum(group: DiffGroup, of: (file: DiffGroup["files"][number]) => number): number {
  return group.files.reduce((total, file) => total + of(file), 0);
}
