/**
 * The diff view's fold state: which groups and files stand open, how a press
 * or a tick folds them, and the lookups that turn a group's number or a file's
 * path into the section rendered for it.
 */
import type { CollapsePlan, FoldTarget, OpenFolds } from "../collapse-plan.ts";
import { foldAnchored, type Anchor, type Fold } from "./fold.ts";

/**
 * Which blocks stand open, read off the controls themselves — a file's header,
 * and the press on a chapter's gate. Complete state, never stale: names only
 * blocks this draw has, so dropped files cannot survive.
 */
export function readOpenFolds(root: HTMLElement): OpenFolds {
  const groups = [...root.querySelectorAll<HTMLElement>(".lsr-group")]
    .filter((section) => isOpen(section, ".lsr-gate-press"))
    .map((section) => Number(section.dataset.groupIndex))
    .filter((index) => Number.isInteger(index));
  const files = [...root.querySelectorAll<HTMLElement>(".lsr-file")]
    .filter((block) => isOpen(block, ".lsr-file-header"))
    .map((block) => block.dataset.file)
    .filter((path) => path !== undefined);
  return { groups, files };
}

/**
 * Puts the review back the way it was left. Switched, not folded: runs on a
 * draw nobody has seen yet, so there is nothing to animate for.
 */
export function applyOpenFolds(root: HTMLElement, open: OpenFolds): void {
  for (const section of root.querySelectorAll<HTMLElement>(".lsr-group")) {
    const press = section.querySelector<HTMLElement>(".lsr-gate-press");
    if (press) switchSection(press, open.groups.includes(Number(section.dataset.groupIndex)));
  }
  for (const block of root.querySelectorAll<HTMLElement>(".lsr-file")) {
    const header = block.querySelector<HTMLElement>(".lsr-file-header");
    const path = block.dataset.file;
    if (header && path !== undefined) switchSection(header, open.files.includes(path));
  }
}

function isOpen(block: HTMLElement, selector: string): boolean {
  const header = block.querySelector<HTMLElement>(selector);
  return header !== null && isExpanded(header);
}

/**
 * Applies a tick's folds as one anchored gesture. Headers take their new state
 * at once — a shut group must read as shut to anything asking, whatever its
 * animation is still doing — and the blocks fold together under one correction.
 */
export function applyCollapsePlan(root: HTMLElement, plan: CollapsePlan): void {
  const folds: Fold[] = [];
  for (const step of plan.steps) {
    const header = foldControl(root, step.target);
    const content = header === null ? null : contentOf(header);
    if (header === null || content === null) continue;
    markExpanded(header, step.expanded);
    folds.push({ content, expanded: step.expanded, animated: step.animated });
  }
  foldAnchored(folds, plan.anchor === undefined ? null : foldAnchor(root, plan.anchor));
}

/**
 * What a tick holds still while folding. File: the tick row just pressed — on
 * screen by construction and it survives the fold; the header may be a
 * thousand lines up. Group: the section, not the gate inside it — the gate is
 * drawn only while the chapter is shut, so it is measurable on one side of
 * the gesture and not the other, while the section's top edge is where its
 * card lands. It is the one allowed to walk down onto the top edge as it
 * closes, because nothing inside it survives.
 */
function foldAnchor(root: HTMLElement, target: FoldTarget): Anchor | null {
  if (target.kind === "group") {
    const section = groupSection(root, target.index);
    return section === null ? null : { element: section, walk: true };
  }
  const foot = fileBlock(root, target.path)?.querySelector<HTMLElement>(".lsr-file-foot");
  return foot ? { element: foot, walk: false } : null;
}

/**
 * The control that stands for one block of the plan, whichever kind it names:
 * a file's header, or the press on a chapter's gate.
 */
function foldControl(root: HTMLElement, target: FoldTarget): HTMLElement | null {
  const scope =
    target.kind === "group" ? groupSection(root, target.index) : fileBlock(root, target.path);
  const selector = target.kind === "group" ? ".lsr-gate-press" : ".lsr-file-header";
  return scope?.querySelector<HTMLElement>(selector) ?? null;
}

/** The one place that turns a group's number into the section rendered for it. */
export function groupSection(root: HTMLElement, index: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.lsr-group[data-group-index="${index}"]`);
}

/** The same for a file, whose path is a selector only once escaped. */
export function fileBlock(root: HTMLElement, path: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.lsr-file[data-file="${CSS.escape(path)}"]`);
}

export function isExpanded(header: HTMLElement): boolean {
  return header.getAttribute("aria-expanded") === "true";
}

/**
 * Header state and content visibility in one step. Switched, not folded: on a
 * draw nobody has seen yet, and on the gate press, where the card the fold
 * would have been anchored to is itself what goes away.
 */
export function switchSection(header: HTMLElement, expanded: boolean): void {
  markExpanded(header, expanded);
  const content = contentOf(header);
  if (content) content.hidden = !expanded;
}

/** The same, folded rather than switched, with the header itself held still. */
export function foldSection(header: HTMLElement, expanded: boolean): void {
  markExpanded(header, expanded);
  const content = contentOf(header);
  // Anchor the pressed header: above the folding block, so it never travels.
  if (content)
    foldAnchored([{ content, expanded, animated: true }], { element: header, walk: false });
}

function markExpanded(header: HTMLElement, expanded: boolean): void {
  header.setAttribute("aria-expanded", String(expanded));
}

/** The block a header opens and shuts, which the markup names by id. */
function contentOf(header: HTMLElement): HTMLElement | null {
  const contentId = header.getAttribute("aria-controls");
  return contentId === null ? null : document.getElementById(contentId);
}
