/** diff2html wraps each side of a side-by-side diff in one of these. */
const COLUMN_SELECTOR = ".d2h-file-side-diff";

/**
 * Keeps a selection inside the side-by-side column it started in. Two guards,
 * because a selection can grow by mouse or by keyboard:
 * a drag out of a column is stopped by making the other column unselectable
 * (CSS, keyed off `data-lock-column`), and any selection that still ends up in
 * the other column — shift+arrow, double-click, programmatic — is pulled back
 * to the edge of the column it was anchored in. Cross-column text would
 * interleave old and new code into one unusable annotation.
 */
export function lockSelectionToColumn(diffRoot: HTMLElement): void {
  document.addEventListener("mousedown", (event) => {
    const column = event.target instanceof Node ? columnOf(event.target) : null;
    if (column) diffRoot.dataset.lockColumn = side(column);
    else delete diffRoot.dataset.lockColumn;
  });
  document.addEventListener("mouseup", () => {
    delete diffRoot.dataset.lockColumn;
  });
  document.addEventListener("selectionchange", () => {
    const selection = document.getSelection();
    if (!selection) return;
    const anchor = columnOf(selection.anchorNode);
    const focus = columnOf(selection.focusNode);
    // No column on either end means the unified view or a selection outside the
    // diff; the same column on both ends is the case this guard is protecting.
    if (!anchor || !focus || anchor === focus) return;
    const forward = Boolean(
      anchor.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Pulling the loose end back to the near edge of the anchor column keeps
    // what the reviewer selected there and drops everything past the border.
    selection.extend(anchor, forward ? anchor.childNodes.length : 0);
  });
}

function columnOf(node: Node | null): HTMLElement | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  return element?.closest<HTMLElement>(COLUMN_SELECTOR) ?? null;
}

function side(column: HTMLElement): "left" | "right" {
  return column.matches(":first-child") ? "left" : "right";
}
