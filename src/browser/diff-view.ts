import type { DiffFile, DiffGroup } from "../diff-extract.ts";
import { escapeHtml } from "../escape-html.ts";
import { relocationOf, unchangedRelocationOf, type Relocation } from "../file-relocation.ts";
import { reviewPaths } from "../review-files.ts";
import type { Approval } from "../rounds/history.ts";
import {
  APPROVED_FORM_OPTIONS,
  BRANCH_OPTION,
  DEFAULT_FILE_FORM,
  FULL_OPTION,
  LAST_ROUND_FORM_OPTIONS,
} from "./approved-form.ts";
import { commentedOn } from "./commented-files.ts";
import type { DiffRenderer } from "./diff-renderer.ts";
import { clampFocus, renderChapterGate, renderFocusBar } from "./focus-mode.ts";
import { approvedLabel, renderGroupIndex } from "./group-index.ts";
import { LOGIC_BADGE_LABEL, heaviestFiles } from "./hunk-complexity.ts";
import { pathLabel } from "./path-label.ts";

export type ApprovalMap = Record<string, Approval>;

export interface ReviewRender {
  groups: DiffGroup[];
  approved: string[];
  renderer: DiffRenderer;
  approval: ApprovalMap;
  /** Annotated by the reviewer in the round before this one. */
  commented: ReadonlySet<string>;
  /** Edited between the last two rounds, per `round-changes.ts`: these offer the `Since last round` switch. */
  sinceLastRound: ReadonlySet<string>;
  /**
   * Undefined for the overview. Every other chapter is left out of the markup
   * entirely — not hidden, absent — which is what makes a big review fast to
   * draw and to scroll.
   */
  focus?: number | undefined;
}

/**
 * Pure on purpose: markup asserted without a DOM. The overview is the chapter
 * index with no diff at all (diffs below the index once made the opening
 * screen a wall); `renderFocused` is the only thing that draws a chapter.
 * Files keep their group's order regardless of approval: reordering ticked
 * files at redraw once made reviewers lose their place.
 */
export function renderGroups(review: ReviewRender): string {
  const { groups, approved } = review;
  if (groups.length === 0) {
    return `<p class="lsr-empty">No changes to review.</p>`;
  }
  const focus = clampFocus(review.focus, groups.length);
  if (focus !== undefined) return renderFocused(review, focus);
  return renderGroupIndex(groups, approved);
}

function renderFocused(review: ReviewRender, focus: number): string {
  const group = review.groups[focus]!;
  return `${renderFocusBar(review.groups, focus)}\n${renderGroup(group, focus, review)}`;
}

/** A path the round said nothing about cannot have been approved in it. */
function approvalOf(file: DiffFile, approval: ApprovalMap): Approval {
  return approval[file.path] ?? "unapproved";
}

export function counterLabel(group: DiffGroup, approved: string[]): string {
  return approvedLabel(approvedCount(group, approved), group.files.length);
}

/**
 * Says "files" (group counters do not) because it stands next to the progress
 * bar, whose widths are lines — without the word they read as two answers to
 * one question.
 */
export function overallCounterLabel(groups: DiffGroup[], approved: string[]): string {
  const paths = reviewPaths(groups);
  if (paths.size === 0) return "nothing to review";
  const done = [...paths].filter((path) => approved.includes(path)).length;
  return `${done}/${paths.size} files approved`;
}

/**
 * Counted off the same paths as the header counter, so sentence and number
 * cannot disagree. No files means not approved, per `groupApproved`'s reason.
 */
export function reviewApproved(groups: DiffGroup[], approved: string[]): boolean {
  const paths = reviewPaths(groups);
  return paths.size > 0 && [...paths].every((path) => approved.includes(path));
}

export function approvedCount(group: DiffGroup, approved: string[]): number {
  return group.files.filter((file) => approved.includes(file.path)).length;
}

/**
 * Derived, never stored: the server keeps a list of approved paths and nothing
 * else, so a group's mark cannot drift out of step with the ticks it is made
 * of. A group with no files in it is not approved — vacuous truth would tick a
 * box for work nobody did.
 */
export function groupApproved(group: DiffGroup, approved: string[]): boolean {
  return group.files.length > 0 && approvedCount(group, approved) === group.files.length;
}

export interface GroupApprovalFlip {
  index: number;
  approved: boolean;
}

export interface FileApprovalFlip {
  path: string;
  approved: boolean;
}

/**
 * Only flips are reported (here and for files): what the reviewer opened by
 * hand is theirs to close, so a tick must move nothing it did not change.
 */
export function groupApprovalFlips(
  groups: DiffGroup[],
  before: string[],
  after: string[],
): GroupApprovalFlip[] {
  return groups.flatMap((group, index) => {
    const approved = groupApproved(group, after);
    return approved === groupApproved(group, before) ? [] : [{ index, approved }];
  });
}

export function fileApprovalFlips(
  groups: DiffGroup[],
  before: string[],
  after: string[],
): FileApprovalFlip[] {
  return [...reviewPaths(groups)].flatMap((path) => {
    const approved = after.includes(path);
    return approved === before.includes(path) ? [] : [{ path, approved }];
  });
}

export function toggleFileApproved(approved: string[], path: string, checked: boolean): string[] {
  return checked ? union(approved, [path]) : approved.filter((entry) => entry !== path);
}

export function toggleGroupApproved(
  approved: string[],
  group: DiffGroup,
  checked: boolean,
): string[] {
  const paths = group.files.map((file) => file.path);
  return checked ? union(approved, paths) : approved.filter((entry) => !paths.includes(entry));
}

function union(approved: string[], paths: string[]): string[] {
  return [...approved, ...paths.filter((path) => !approved.includes(path))];
}

/**
 * Always drawn shut, whichever way it was entered: the gate is the chapter's
 * face until the reviewer presses through it, and a draw that opened the diff
 * by itself would put the lines back above the reason for them. The mount
 * re-opens what this reviewer already opened in this round.
 */
function renderGroup(group: DiffGroup, index: number, review: ReviewRender): string {
  const { approved, renderer, approval, commented, sinceLastRound } = review;
  const allApproved = groupApproved(group, approved);
  // The diff is rendered and hidden rather than left out: the gate's press is
  // then the fold that is already there, so the chapter reopens instantly and
  // a tick that finishes it can shut it back onto its card. The tick itself
  // sits at the foot, as a file's own tick does, because you approve what you
  // have read past; outside the folding element, so it is on the card as well
  // as under the lines, and the tick that shuts a chapter is still on screen
  // once it has.
  const contentId = `lsr-group-content-${index}`;
  const densest = heaviestFiles(group);
  return `<section class="lsr-group" data-group-index="${index}">
  ${renderChapterGate({ group, contentId, counter: counterLabel(group, approved) })}
  <div class="lsr-group-content" id="${contentId}" hidden>
    ${group.files
      .map((file, fileIndex) =>
        renderFile({
          file,
          groupName: group.name,
          approved,
          renderer,
          id: `${index}-${fileIndex}`,
          approval: approvalOf(file, approval),
          densestLogic: densest.includes(file.path),
          commented: commentedOn(file, commented),
          sinceLastRound: sinceLastRound.has(file.path),
        }),
      )
      .join("\n    ")}
  </div>
  <div class="lsr-row lsr-group-foot"
    ><label class="lsr-tick"
      ><span class="lsr-tick-label">approve chapter</span
      ><input type="checkbox" class="lsr-tick-all" data-group-index="${index}"${allApproved ? " checked" : ""}
        aria-label="Approve chapter: mark every file in it approved" /></label
  ></div>
</section>`;
}

interface FileRow {
  file: DiffFile;
  groupName: string;
  approved: string[];
  renderer: DiffRenderer;
  id: string;
  approval: Approval;
  densestLogic: boolean;
  commented: boolean;
  sinceLastRound: boolean;
}

function renderFile(row: FileRow): string {
  const { file, groupName, approved, renderer, id, approval } = row;
  const path = escapeHtml(file.path);
  const isApproved = approved.includes(file.path);
  const contentId = `lsr-file-content-${id}`;
  // `data-group`: which concern an annotation was made under.
  // `data-status`: which versions exist, so the page only asks git for those.
  // Every identity (`data-file`, the tick, the label) is the new path alone; a
  // relocated file's old path is words on the row, never a key.
  // Tick follows the diff (reading ends at the last line; a top tick means
  // scrolling back), and is a sibling of it so collapsing keeps it on screen.
  return `<div class="lsr-file" data-file="${path}" data-approval="${approval}"${formAttribute(file, approval, row.sinceLastRound)} data-status="${file.status}" data-group="${escapeHtml(groupName)}">
      <div class="lsr-row">
        <button type="button" class="lsr-file-header" aria-expanded="${!isApproved}" aria-controls="${contentId}">
          <span class="lsr-file-path">${pathLabel(file)}</span>
          <span class="lsr-file-stats">+${file.insertions} −${file.deletions}</span>${relocationBadge(file)}${logicBadge(row.densestLogic)}${commentedBadge(row.commented)}${approvalBadge(approval)}
        </button>${formSwitch(file, approval, row.sinceLastRound)}
      </div>
      <div class="lsr-file-diff" id="${contentId}"${isApproved ? " hidden" : ""}>${renderFileBody(file, renderer)}</div>
      <div class="lsr-row lsr-file-foot"
        ><label class="lsr-tick"
          ><span class="lsr-tick-label">approve</span
          ><input type="checkbox" class="lsr-approved" data-file="${path}"${isApproved ? " checked" : ""}
            aria-label="Mark ${path} approved" /></label
      ></div>
    </div>`;
}

/**
 * Git's similarity, which the diff alone never says: `98% identical` is the
 * difference between skimming and re-reading 400 lines. The old path is not
 * repeated here: the row's path already reads `old → new`.
 */
function relocationBadge(file: DiffFile): string {
  const relocation = relocationOf(file);
  if (relocation === undefined) return "";
  return `<span class="lsr-file-rename">${relocation}${similarityNote(file)}</span>`;
}

function similarityNote(file: DiffFile): string {
  if (unchangedRelocationOf(file) !== undefined) return ", identical";
  if (file.similarity === undefined) return "";
  return `, ${file.similarity}% identical`;
}

function logicBadge(densestLogic: boolean): string {
  if (!densestLogic) return "";
  return `<span class="lsr-file-logic">${LOGIC_BADGE_LABEL}</span>`;
}

/** The panel is the only other place that knows, far from the diff. Label only, never a count. */
function commentedBadge(commented: boolean): string {
  if (!commented) return "";
  return `<span class="lsr-file-commented">commented last round</span>`;
}

/**
 * The one thing the row cannot show: a file edited after approval looks
 * exactly like one nobody ever approved.
 */
function approvalBadge(approval: Approval): string {
  if (approval !== "needs-reapproval") return "";
  return `<span class="lsr-file-approval">changed after approval</span>`;
}

/**
 * Only files with a second view carry `data-form` — the one place saying which
 * view a file shows, read by both the mount and the selection code.
 */
function formAttribute(file: DiffFile, approval: Approval, sinceLastRound: boolean): string {
  return switchOptions(file, approval, sinceLastRound) === undefined
    ? ""
    : ` data-form="${DEFAULT_FILE_FORM}"`;
}

/**
 * Withdrawn approval outranks the round comparison: the approved form already
 * covers everything since the tick, so one file never carries two comparisons.
 * The whole-file view joins last, except where no new side exists to show.
 */
function switchOptions(
  file: DiffFile,
  approval: Approval,
  sinceLastRound: boolean,
): readonly { form: string; label: string }[] | undefined {
  const pair =
    approval === "needs-reapproval"
      ? APPROVED_FORM_OPTIONS
      : sinceLastRound
        ? LAST_ROUND_FORM_OPTIONS
        : undefined;
  if (file.status === "deleted" || file.status === "binary") return pair;
  return [...(pair ?? [BRANCH_OPTION]), FULL_OPTION];
}

/**
 * Sibling of the header, not child: a button inside a button is neither valid
 * markup nor clickable. Branch diff starts pressed on every draw.
 */
function formSwitch(file: DiffFile, approval: Approval, sinceLastRound: boolean): string {
  const pair = switchOptions(file, approval, sinceLastRound);
  if (pair === undefined) return "";
  const path = escapeHtml(file.path);
  const options = pair
    .map(
      ({ form, label }) =>
        `<button type="button" class="lsr-switch-option lsr-form-option" data-form="${form}" aria-pressed="${form === DEFAULT_FILE_FORM}">${label}</button>`,
    )
    .join("\n          ");
  return `<div class="lsr-switch lsr-form-switch" role="group" aria-label="Which diff to show for ${path}">
          ${options}
        </div>`;
}

/**
 * Exported: the mount re-renders it when a file switches back from the
 * approved form. A relocation git found identical is a header-only patch,
 * which diff2html draws as "File without changes" — true, and silent on the
 * one thing there is to know, where it came from.
 */
export function renderFileBody(file: DiffFile, renderer: DiffRenderer): string {
  if (file.status === "binary") {
    return `<p class="lsr-binary">Binary file — no diff to show.</p>`;
  }
  const unchanged = unchangedRelocationOf(file);
  const from = file.previousPath;
  // Every relocation has a `from` (`relocationOf`), which the type cannot say;
  // a record without one gets the renderer's own words rather than an empty name.
  if (unchanged === undefined || from === undefined) return renderer.renderFile(file.diff);
  return `<p class="lsr-unchanged">${UNCHANGED_RELOCATION[unchanged]} unchanged from <code>${escapeHtml(from)}</code>.</p>`;
}

const UNCHANGED_RELOCATION: Record<Relocation, string> = {
  moved: "Moved",
  renamed: "Renamed",
};
