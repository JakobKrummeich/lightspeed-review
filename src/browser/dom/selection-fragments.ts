import { anchorFor, type SelectionFragment } from "../annotation.ts";
import { ANNOTATABLE_FORM } from "../approved-form.ts";
import { lineNumbers, sideColumns } from "./line-numbers.ts";
import { selectionInLine, type LineSelection } from "./line-selection.ts";

const FILE_SELECTOR = ".lsr-file";

/** diff2html's line rows, unified and side by side. */
const LINE_SELECTOR = ".d2h-code-line, .d2h-code-side-line";

/**
 * Separate from the popup: this is where a selection becomes what the agent
 * reads, testable without a browser.
 */
export function selectionFragments(
  selection: Selection,
  diffRoot: HTMLElement,
): SelectionFragment[] {
  if (selection.isCollapsed || selection.rangeCount === 0) return [];
  const range = selection.getRangeAt(0);
  const fragments: SelectionFragment[] = [];
  for (const block of diffRoot.querySelectorAll<HTMLElement>(FILE_SELECTOR)) {
    const fragment = range.intersectsNode(block) ? fragmentIn(block, range) : undefined;
    if (fragment !== undefined) fragments.push(fragment);
  }
  return fragments;
}

interface MarkedLine {
  line: HTMLElement;
  selection: LineSelection;
}

/**
 * Only the branch diff yields anything: other forms are numbered against other
 * commits, while ledger anchors are facts about the branch diff — and the
 * ledger is training data. Allowlist, not refusal list: a later form is
 * unannotatable until someone decides. No `data-form` means branch diff by
 * definition.
 */
function fragmentIn(block: HTMLElement, range: Range): SelectionFragment | undefined {
  if ((block.dataset.form ?? ANNOTATABLE_FORM) !== ANNOTATABLE_FORM) return undefined;
  const marked = markedLines(block, range);
  // No path means no anchor for the agent, so such a block is not annotatable.
  if (marked.length === 0 || !block.dataset.file) return undefined;
  const columns = sideColumns(block);
  return {
    file: block.dataset.file,
    group: block.dataset.group ?? "",
    text: marked.map((entry) => entry.selection.text).join("\n"),
    anchor: anchorFor(
      marked.map((entry) => ({
        ...lineNumbers(entry.line, columns),
        columns: entry.selection.columns,
      })),
    ),
  };
}

function markedLines(block: HTMLElement, range: Range): MarkedLine[] {
  const marked: MarkedLine[] = [];
  for (const line of block.querySelectorAll<HTMLElement>(LINE_SELECTOR)) {
    if (!range.intersectsNode(line)) continue;
    const selection = selectionInLine(line, range);
    if (selection !== undefined) marked.push({ line, selection });
  }
  return marked;
}
