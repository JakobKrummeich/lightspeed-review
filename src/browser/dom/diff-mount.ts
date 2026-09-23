import type { DiffGroup } from "../../diff-extract.ts";
import { tickCollapsePlan, type OpenFolds } from "../collapse-plan.ts";
import { commentedLastRound } from "../commented-files.ts";
import { clampFocus, nextChapterToRead } from "../focus-mode.ts";
import { createDiff2HtmlRenderer, type DiffOutputFormat } from "../diff2html-adapter.ts";
import type { DiffRenderer } from "../diff-renderer.ts";
import {
  fileApprovalFlips,
  groupApprovalFlips,
  renderGroups,
  reviewApproved,
  type GroupApprovalFlip,
} from "../diff-view.ts";
import { sweepApproved } from "../group-index.ts";
import { renderProgressBar } from "../progress-bar.ts";
import { createApprovedFormStore, type ApprovedFormStore } from "./approved-form-store.ts";
import {
  applyCollapsePlan,
  applyOpenFileLists,
  applyOpenFolds,
  fileBlock,
  foldSection,
  groupSection,
  isExpanded,
  readOpenFileLists,
  readOpenFolds,
  switchSection,
} from "./diff-folds.ts";
import { findLine, type LinePlace } from "./line-numbers.ts";
import { applyApprovedState, applyProgressState, nextApproved } from "./tick-patch.ts";
import { persistApproved, type SessionData } from "./session-api.ts";
import { changedSinceLastRound } from "../round-changes.ts";
import { highlightDiff } from "./syntax-highlight.ts";

/**
 * The diff cannot tell on its own what a `session` event was (rounds are the
 * page's business), and the two want opposite things: regroup draws fresh,
 * same-round must leave the reviewer's view alone.
 */
export type SessionChange = "regrouped" | "same-round";

export interface MountedDiff {
  update(session: SessionData, change: SessionChange): void;
  setFormat(format: DiffOutputFormat): void;
  /**
   * How the panel asks for a comment's lines: enters the chapter, unfolds the
   * file, scrolls to the line (or the file when none).
   */
  reveal(file: string, place?: LinePlace): void;
}

export interface DiffViewOptions {
  root: HTMLElement;
  progress: HTMLElement;
  key: string;
  session: SessionData;
  format: DiffOutputFormat;
  /** Undefined is not "everything shut": an unread round opens as rendered. */
  open: OpenFolds | undefined;
  /** Undefined is the overview, which renumbered indexes also collapse to. */
  focus: number | undefined;
  /** Never called for the initial state. */
  onFocus(focus: number | undefined): void;
  /**
   * Reported after every draw and fold; the page, not the diff, stamps which
   * round it belongs to.
   */
  onOpen(open: OpenFolds): void;
  /**
   * The approved list lives only in here, so this is the page's only way to
   * know — reported on every draw and tick, so a round that opens fully
   * approved is right from the first frame.
   */
  onApproved(allApproved: boolean): void;
}

interface DiffViewState {
  groups: DiffGroup[];
  approved: string[];
  approval: SessionData["approval"];
  /**
   * Derived, not sent: the payload already carries conversation and rounds,
   * and a round is only redrawn from a whole `SessionData`.
   */
  commented: Set<string>;
  /** Derived for the same reason as `commented`. */
  sinceLastRound: Set<string>;
  renderer: DiffRenderer;
  /**
   * Held across redraws on purpose: a format switch is a question about the
   * lines, not an instruction to shut the review.
   */
  open: OpenFolds | undefined;
  /** Clamped on the way in: a stored index may point into a grouping that is gone. */
  focus: number | undefined;
}

interface DiffView {
  readonly options: DiffViewOptions;
  readonly state: DiffViewState;
  readonly forms: ApprovedFormStore;
}

export function mountDiffView(options: DiffViewOptions): MountedDiff {
  const state: DiffViewState = {
    groups: options.session.groups,
    approved: options.session.approved,
    approval: options.session.approval,
    commented: commentedLastRound(options.session.conversation, options.session.rounds),
    sinceLastRound: changedSinceLastRound(options.session.rounds),
    renderer: createDiff2HtmlRenderer({ outputFormat: options.format }),
    open: options.open,
    focus: clampFocus(options.focus, options.session.groups.length),
  };
  const view: DiffView = {
    options,
    state,
    forms: createApprovedFormStore({
      root: options.root,
      key: options.key,
      groups: () => state.groups,
      renderer: () => state.renderer,
    }),
  };
  draw(view);
  options.root.addEventListener("click", (event) => handleClick(view, event));
  options.root.addEventListener("change", (event) => handleTick(view, event));
  // The bar lives in the header, outside root's listeners: own listener needed.
  options.progress.addEventListener("click", (event) => handleSegmentClick(view, event));
  return {
    update(fresh: SessionData, change: SessionChange) {
      state.groups = fresh.groups;
      state.approved = fresh.approved;
      state.approval = fresh.approval;
      state.commented = commentedLastRound(fresh.conversation, fresh.rounds);
      state.sinceLastRound = changedSinceLastRound(fresh.rounds);
      if (change === "regrouped") forgetRound(view);
      // Group count can shrink under a held focus even inside a round; the
      // held index must fall to the overview with the render, or a later count
      // would silently revive a focus the reviewer saw dissolve.
      state.focus = clampFocus(state.focus, state.groups.length);
      draw(view);
    },
    setFormat(next: DiffOutputFormat) {
      state.renderer = createDiff2HtmlRenderer({ outputFormat: next });
      draw(view);
    },
    reveal(file: string, place?: LinePlace) {
      reveal(view, file, place);
    },
  };
}

/**
 * Entering the chapter is a real focus press (reported, remembered), so a
 * reload opens where the jump landed. The fold opens like a click would: a
 * jump onto an approved-shut file must show the lines, not the lid.
 */
function reveal(view: DiffView, file: string, place?: LinePlace): void {
  const index = view.state.groups.findIndex((held) =>
    held.files.some((candidate) => candidate.path === file),
  );
  if (index === -1) return;
  if (view.state.focus !== index) setFocus(view, index);
  // Through the gate on the way in: a jump asked for one file's lines, and the
  // reviewer did not ask to read the chapter's card first.
  openChapter(view, index);
  const block = fileBlock(view.options.root, file);
  if (!block) return;
  unfoldFile(view, block);
  const target = (place && findLine(block, place)) ?? block;
  target.scrollIntoView({ block: "center" });
}

function unfoldFile(view: DiffView, block: HTMLElement): void {
  const header = block.querySelector<HTMLElement>(".lsr-file-header");
  if (!header || isExpanded(header)) return;
  foldSection(header, true);
  reportOpen(view);
}

/**
 * Switched rather than folded: the card goes away in the same moment, so there
 * is no landmark left for a height animation to hold still.
 */
function openGate(view: DiffView, press: HTMLElement): void {
  if (isExpanded(press)) return;
  switchSection(press, true);
  reportOpen(view);
}

function openChapter(view: DiffView, index: number): void {
  const gate = groupSection(view.options.root, index)?.querySelector<HTMLElement>(
    ".lsr-gate-press",
  );
  if (gate) openGate(view, gate);
}

function draw(view: DiffView): void {
  const { root, progress, key } = view.options;
  const { groups, approved, renderer, approval, commented, sinceLastRound, focus } = view.state;
  // Off the markup about to go, not off held state: the browser keeps this
  // fold and tells the mount nothing (`readOpenFileLists`).
  const fileLists = readOpenFileLists(root);
  root.innerHTML = renderGroups({
    groups,
    approved,
    renderer,
    approval,
    commented,
    sinceLastRound,
    focus,
  });
  // Before anything is measured or painted: the reviewer is about to be
  // scrolled back into a group opened here.
  if (view.state.open) applyOpenFolds(root, view.state.open);
  applyOpenFileLists(root, fileLists);
  reportOpen(view);
  view.forms.restore();
  // The one place the bar is built: a re-group replaces its segments, a tick
  // only repaints them.
  progress.innerHTML = renderProgressBar(groups, approved, focus);
  view.options.onApproved(reviewApproved(groups, approved));
  // Not awaited: the diff is readable before its colours land.
  highlightDiff(root, key).catch(() =>
    console.error("lightspeed: syntax highlighting is unavailable"),
  );
}

// `<details>` cannot centre a control against its summary row, so sections
// are a header button plus a content element this handler toggles.
function handleClick(view: DiffView, event: Event): void {
  const target =
    event.target instanceof Element
      ? event.target.closest(
          ".lsr-tick, .lsr-gate-files-summary, .lsr-gate-press, .lsr-file-header, .lsr-index-entry, .lsr-form-option, .lsr-focus-exit, .lsr-focus-prev, .lsr-focus-next, .lsr-sweep-approve, .lsr-group",
        )
      : null;
  if (!(target instanceof HTMLElement)) return;
  if (isBrowserPress(target)) return;
  if (answeredItself(view, target)) return;
  if (isFocusControl(target)) {
    const press = focusPress(target, view.state.focus, view.state.groups.length);
    if (press) setFocus(view, press.to);
    return;
  }
  foldSection(target, !isExpanded(target));
  reportOpen(view);
}

/**
 * True when a press did its whole job on the spot; everything else falls
 * through to the fold below.
 */
function answeredItself(view: DiffView, target: HTMLElement): boolean {
  if (target.classList.contains("lsr-form-option")) {
    // Not awaited: the press lands now, git's diff arrives when it arrives.
    void view.forms.pick(target);
    return true;
  }
  if (target.classList.contains("lsr-sweep-approve")) {
    approveSweep(view);
    return true;
  }
  const press = gatePressOf(target);
  if (press) {
    // Anywhere on a shut card is a press: the button names the action and the
    // whole card takes it. Once the diff is up the section is just the room
    // the lines are read in, and a press there is a press on nothing.
    if (isExpanded(press)) return true;
    openGate(view, press);
    // Top of the chapter, as entering one does: the press was answered with a
    // screen of diff, and its first line is where reading starts.
    view.options.root.scrollIntoView({ block: "start" });
    return true;
  }
  return false;
}

function gatePressOf(target: HTMLElement): HTMLElement | undefined {
  if (target.classList.contains("lsr-gate-press")) return target;
  if (!target.classList.contains("lsr-group")) return undefined;
  return target.querySelector<HTMLElement>(".lsr-gate-press") ?? undefined;
}

function handleSegmentClick(view: DiffView, event: Event): void {
  const target =
    event.target instanceof Element ? event.target.closest(".lsr-progress-segment") : null;
  if (!(target instanceof HTMLElement)) return;
  const press = indexPress(target);
  if (press) setFocus(view, press.to);
}

/**
 * Nothing new reaches the server: it is the tick the reviewer already has, in
 * bulk, down the same POST as one box. A redraw and not a patch, because the
 * survey has no in-place patch: `applyApprovedState` walks chapters that are
 * on screen, and on this screen none of them are; the counters that must
 * change are the index rows, which only a draw writes. Silent when the press
 * changes nothing, so a second press does not repost a list the server already
 * has.
 */
function approveSweep(view: DiffView): void {
  const { state } = view;
  const next = sweepApproved(state.groups, state.approved);
  if (next.length === state.approved.length) return;
  state.approved = next;
  draw(view);
  persistApproved(view.options.key, state.approved).catch(() =>
    console.error("lightspeed: approved state was not saved"),
  );
}

function handleTick(view: DiffView, event: Event): void {
  const { root, progress, key } = view.options;
  const { state } = view;
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const next = nextApproved(state.groups, state.approved, input);
  if (!next) return;
  // Flips read against the list the tick replaced: only what this tick
  // finished or undid folds; hand-opened blocks stay as left.
  const fileFlips = fileApprovalFlips(state.groups, state.approved, next);
  const groupFlips = groupApprovalFlips(state.groups, state.approved, next);
  state.approved = next;
  const onward = chapterToReadNext(state, groupFlips);
  if (onward !== undefined) {
    // A whole draw, so nothing below is patched.
    setFocus(view, onward);
  } else {
    applyApprovedState(root, state.groups, state.approved);
    applyCollapsePlan(root, tickCollapsePlan(fileFlips, groupFlips));
    // A tick's folds are as much a state worth restoring as hand-opened ones.
    reportOpen(view);
    applyProgressState(progress, state.groups, state.approved);
  }
  // A tick redraws nothing, so completion has to be reported from here too.
  view.options.onApproved(reviewApproved(state.groups, state.approved));
  // Tick stays on screen either way; log rather than lose it silently.
  persistApproved(key, state.approved).catch(() =>
    console.error("lightspeed: approved state was not saved"),
  );
}

/**
 * Read off the group flips, so a file tick that happens to complete the
 * chapter and the chapter's own tick are one case.
 */
function chapterToReadNext(state: DiffViewState, flips: GroupApprovalFlip[]): number | undefined {
  const { focus } = state;
  if (focus === undefined) return undefined;
  if (!flips.some((flip) => flip.index === focus && flip.approved)) return undefined;
  return nextChapterToRead(state.groups, state.approved, focus);
}

function reportOpen(view: DiffView): void {
  view.state.open = readOpenFolds(view.options.root);
  view.options.onOpen(view.state.open);
}

/**
 * A new round is a new head commit: fetched forms answer a diff that no longer
 * exists, and paths recur, so a kept answer would be served as the new round's.
 * Folds likewise: the old round's open list may name files this one does not
 * have.
 */
function forgetRound(view: DiffView): void {
  view.forms.forget();
  view.state.open = undefined;
  // Only the held copy needs clearing: the stored one dies with the round,
  // since the next `onOpen` carries the new round number and `review-memory`
  // empties on round change.
  view.state.focus = undefined;
}

/**
 * Folds deliberately let go: each view opens as rendered, and carrying one's
 * folds into the other would name blocks it does not draw.
 */
function setFocus(view: DiffView, next: number | undefined): void {
  view.state.focus = clampFocus(next, view.state.groups.length);
  view.state.open = undefined;
  draw(view);
  view.options.onFocus(view.state.focus);
  // Instant: everything on screen is a fresh draw anyway.
  view.options.root.scrollIntoView({ block: "start" });
}

/**
 * Answered by the browser itself, so the card they sit on must not read them
 * as a request to open: a tick fires `change`, and the file list's summary
 * folds its own `<details>`.
 */
const BROWSER_PRESSES = ["lsr-tick", "lsr-gate-files-summary"];

function isBrowserPress(target: HTMLElement): boolean {
  return BROWSER_PRESSES.some((name) => target.classList.contains(name));
}

const FOCUS_CONTROLS = ["lsr-index-entry", "lsr-focus-exit", "lsr-focus-prev", "lsr-focus-next"];

function isFocusControl(target: HTMLElement): boolean {
  return FOCUS_CONTROLS.some((name) => target.classList.contains(name));
}

/**
 * Wrapped rather than bare: "to the overview" is undefined and so is
 * "nowhere", and `Number` on a missing attribute would read 0 and focus the
 * wrong chapter.
 */
function focusPress(
  target: HTMLElement,
  focus: number | undefined,
  count: number,
): { to: number | undefined } | undefined {
  if (target.classList.contains("lsr-focus-exit")) return { to: undefined };
  if (target.classList.contains("lsr-index-entry")) return indexPress(target);
  if (focus === undefined) return undefined;
  if (target.classList.contains("lsr-focus-prev")) return step(focus, -1, count);
  if (target.classList.contains("lsr-focus-next")) return step(focus, 1, count);
  return undefined;
}

/**
 * The disabled ends never fire, but if one did, the clamp would read -1 as
 * "leave focus mode".
 */
function step(focus: number, by: number, count: number): { to: number } | undefined {
  const to = focus + by;
  return to >= 0 && to < count ? { to } : undefined;
}

function indexPress(target: HTMLElement): { to: number } | undefined {
  const index = Number(target.dataset.groupIndex);
  return Number.isInteger(index) ? { to: index } : undefined;
}
