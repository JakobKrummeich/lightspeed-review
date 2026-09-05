import type { SelectedColumns } from "../annotation.ts";

/**
 * `Node.TEXT_NODE`, spelled out because the fakes the tests stand this module
 * up with have no DOM globals behind them.
 */
const TEXT_NODE = 3;

/**
 * diff2html renders the `+`/`-` marker and the code as two sibling spans, with
 * these exact classes in both unified and side-by-side modes. Matched as class
 * tokens, not `[class$=...]` suffixes: the highlighter appends `hljs` to the
 * code span's class attribute, and a suffix test on the joined string would
 * stop matching the moment the line is coloured.
 */
const PREFIX_SELECTOR = ".d2h-code-line-prefix";
const CONTENT_SELECTOR = ".d2h-code-line-ctn";

/** What a selection takes from one rendered diff line. */
export interface LineSelection {
  /**
   * The characters the reviewer marked. A line taken whole keeps its `+`/`-`
   * marker so old and new code stay distinguishable; a clipped one is quoted as
   * the file has it, because a marker in front of half a line claims a diff
   * line that does not exist.
   */
  text: string;
  /** Where the selection clipped the line; absent when it took the whole line. */
  columns?: SelectedColumns;
}

/**
 * One line's share of a selection; nothing when the range marks none of its
 * characters (a range ending where a line begins touches without marking).
 * Ends outside the line cover it to its edges — the middle of a multi-line
 * selection — and marker-only selections are whole lines: the marker is not
 * code, so there is no character range to cut to.
 */
export function selectionInLine(line: Element, range: Range): LineSelection | undefined {
  const content = line.querySelector(CONTENT_SELECTOR);
  // No code span: nothing to count columns against, and `textContent` would
  // include template indentation — so taken whole, squeezed to one line.
  if (content === null) return { text: (line.textContent ?? "").trim() };
  const code = content.textContent ?? "";
  const clipped = clipOf(content, code, range);
  if (clipped === undefined) return undefined;
  if (clipped === "whole") return { text: `${prefixOf(line)}${code}` };
  // Columns are 1-based and inclusive, in the UTF-16 code units the DOM counts
  // in: the exclusive end offset of a 0-based range is already the 1-based
  // number of its last unit.
  return {
    text: code.slice(clipped.start, clipped.end),
    columns: { start: clipped.start + 1, end: clipped.end },
  };
}

/** Which side of the line's code a range end that is not inside it falls on. */
type Side = "before" | "after";

/** 0-based offsets into the code, "whole" for all of it, nothing for none of it. */
type Clip = { start: number; end: number } | "whole" | undefined;

/** Where the range's two ends fall in the line's code. */
function clipOf(content: Element, code: string, range: Range): Clip {
  const start = boundaryIn(content, range.startContainer, range.startOffset, "before");
  const end = boundaryIn(content, range.endContainer, range.endOffset, "after");
  // The range passes this line by: it starts after the code, or ends before it.
  if (start === "after" || end === "before") return undefined;
  return spanOf(start === "before" ? 0 : start, end === "after" ? code.length : end, code.length);
}

function spanOf(start: number, end: number, length: number): Clip {
  if (start <= 0 && end >= length) return "whole";
  return start >= end ? undefined : { start, end };
}

/**
 * One range end as an offset into the line's code, or which side it falls on.
 * A container wrapping the code (the row cell a downward drag ends in, as
 * browsers routinely report) is answered exactly by child index. Any other
 * node is another line, so the end falls on the side being asked about.
 */
function boundaryIn(
  content: Element,
  container: Node,
  offset: number,
  outside: Side,
): number | Side {
  const inside = offsetIn(content, container, offset);
  if (inside !== undefined) return inside;
  if (!container.contains(content)) return outside;
  return childHolding(container, content) < offset ? "after" : "before";
}

/** Which child of an ancestor the code sits in. */
function childHolding(container: Node, content: Element): number {
  return [...container.childNodes].findIndex((child) => child.contains(content));
}

function prefixOf(line: Element): string {
  return line.querySelector(PREFIX_SELECTOR)?.textContent ?? "";
}

/**
 * How many characters of `root` come before a range boundary, or undefined when
 * the boundary is not inside `root` at all. Walked by hand rather than with a
 * second `Range`: the code span is a tree of highlight spans, and its text is
 * the only thing the boundary has to be measured against.
 */
function offsetIn(root: Node, container: Node, offset: number): number | undefined {
  if (root === container) {
    return root.nodeType === TEXT_NODE ? offset : lengthBefore(root, offset);
  }
  let before = 0;
  for (const child of root.childNodes) {
    const inside = offsetIn(child, container, offset);
    if (inside !== undefined) return before + inside;
    before += child.textContent?.length ?? 0;
  }
  return undefined;
}

/** In an element the boundary counts children, not characters: `offset` is a child index. */
function lengthBefore(node: Node, children: number): number {
  let length = 0;
  for (const child of [...node.childNodes].slice(0, children)) {
    length += child.textContent?.length ?? 0;
  }
  return length;
}
