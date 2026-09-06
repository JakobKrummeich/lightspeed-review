import type { DiffGroup } from "../diff-extract.ts";
import { escapeHtml } from "../escape-html.ts";
import { isSweep } from "../group-tier.ts";
import { LOGIC_BADGE_LABEL, heaviestGroups } from "./hunk-complexity.ts";

/**
 * One line of the index: everything the reviewer needs before opening a group.
 * Not what the group is for — that is the chapter's own gate, which says it
 * once, at full size, with nothing else on the screen. A clamped grey copy of
 * the same sentences here was a line nobody read: either the reviewer should
 * read it, and then it must be set as though they should, or they should not,
 * and then it has no business on the page.
 */
export interface GroupIndexEntry {
  name: string;
  files: number;
  insertions: number;
  deletions: number;
  approved: number;
  /** This group added the most branching in the review; readable while collapsed. */
  densestLogic: boolean;
  /**
   * Bulk with nothing to decide, so the survey files it in the mechanical lane
   * instead of the reading order. Read off the chapter's tier and nothing else:
   * a chapter that never said says nothing here either (`isSweep`).
   */
  sweep: boolean;
}

export function groupIndexEntries(groups: DiffGroup[], approved: string[]): GroupIndexEntry[] {
  const densest = heaviestGroups(groups);
  return groups.map((group, index) => ({
    name: group.name,
    files: group.files.length,
    insertions: sum(group, (file) => file.insertions),
    deletions: sum(group, (file) => file.deletions),
    approved: group.files.filter((file) => approved.includes(file.path)).length,
    densestLogic: densest.includes(index),
    sweep: isSweep(group),
  }));
}

export function indexCounterLabel(entry: GroupIndexEntry): string {
  return approvedLabel(entry.approved, entry.files);
}

/**
 * Progress wording shared by the index, group counters and header bar: one
 * sentence, everywhere.
 */
export function approvedLabel(done: number, total: number): string {
  return `${done}/${total} approved`;
}

export function indexFilesLabel(entry: GroupIndexEntry): string {
  return filesLabel(entry.files);
}

function filesLabel(files: number): string {
  return `${files} file${files === 1 ? "" : "s"}`;
}

/**
 * What the lane's one press approves: every file of every swept chapter, added
 * to what is already ticked. A union and never a toggle — the same press twice
 * is the same list, where a toggle's second press would untick a lane of
 * twenty-seven files the reviewer had already dealt with. Pure, and the list it
 * returns goes down the same POST as every other tick.
 */
export function sweepApproved(groups: DiffGroup[], approved: string[]): string[] {
  const swept = groups
    .filter(isSweep)
    .flatMap((group) => group.files.map((file) => file.path))
    .filter((path) => !approved.includes(path));
  return [...approved, ...swept];
}

/** One row of the survey: the entry, and the chapter number a press on it names. */
interface IndexRow {
  entry: GroupIndexEntry;
  index: number;
}

/**
 * The opening index. Pure (assertable without a DOM). Entries are buttons,
 * not links: they expand the group too, and a fragment link would land on a
 * collapsed heading. Plain list: reading order is the reviewer's call.
 *
 * Two lists, when the review has bulk in it: the chapters to study in the order
 * the grouping put them, and under them the swept ones in a lane of their own.
 * A review with nothing swept renders exactly what it always did — the lane is
 * absent rather than empty, because a heading saying "0 files, nothing to
 * decide" is a thing to read on a screen built to be read in one look.
 *
 * The split moves nothing: `trailSweeps` (`src/group-tier.ts`) has already put
 * the swept chapters at the end of the array, so this cuts the list where the
 * bulk begins and the lane is a heading and a press over the tail. Ordering
 * here instead would break the one number every surface names a chapter by —
 * `data-group-index` is a position in `groups`, shared with the header bar and
 * the chapter on screen.
 */
export function renderGroupIndex(groups: DiffGroup[], approved: string[]): string {
  if (groups.length === 0) return "";
  const rows = groupIndexEntries(groups, approved).map((entry, index) => ({ entry, index }));
  const study = rows.filter(({ entry }) => !entry.sweep);
  const swept = rows.filter(({ entry }) => entry.sweep);
  return `<nav class="lsr-index" aria-label="Groups in this review">
  ${study.length === 0 ? "" : renderList(study)}
  ${swept.length === 0 ? "" : renderLane(swept)}
</nav>`;
}

function renderList(rows: IndexRow[]): string {
  const items = rows.map(({ entry, index }) => renderEntry(entry, index)).join("\n    ");
  return `<ol class="lsr-index-list">
    ${items}
  </ol>`;
}

/**
 * The mechanical lane: everything the review has already decided is bulk,
 * quarantined under one heading that says how much of it there is. The chapters
 * inside are the same pressable rows as above — a swept chapter is still a
 * chapter, and a reviewer who wants to see what moved must be able to open it —
 * so the lane changes where they are read, never whether they can be.
 *
 * Then the one press the whole feature is for: a reviewer facing 41 files
 * approves most of them on autopilot because every file costs the same tick.
 * Here 27 of them cost one, and the attention that buys goes to the chapters
 * above.
 */
function renderLane(rows: IndexRow[]): string {
  const files = rows.reduce((total, { entry }) => total + entry.files, 0);
  return `<section class="lsr-sweep">
    <h2 class="lsr-sweep-heading">Mechanical — ${filesLabel(files)}, nothing to decide</h2>
    ${renderList(rows)}
    <button type="button" class="lsr-sweep-approve">Approve ${filesLabel(files)}</button>
  </section>`;
}

function renderEntry(entry: GroupIndexEntry, index: number): string {
  return `<li class="lsr-index-item">
      <button type="button" class="lsr-index-entry" data-group-index="${index}">
        <span class="lsr-index-name">${escapeHtml(entry.name)}</span>
        <span class="lsr-index-files">${indexFilesLabel(entry)}</span>
        <span class="lsr-index-lines">+${entry.insertions} −${entry.deletions}</span>
        <span class="lsr-index-counter">${indexCounterLabel(entry)}</span>
        <span class="lsr-index-logic"${entry.densestLogic ? "" : " hidden"}>${LOGIC_BADGE_LABEL}</span>
      </button>
    </li>`;
}

function sum(group: DiffGroup, of: (file: DiffGroup["files"][number]) => number): number {
  return group.files.reduce((total, file) => total + of(file), 0);
}
