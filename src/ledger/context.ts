import type { AnchorFields, ContextFields } from "./records.ts";

/**
 * Lines kept either side of the annotated range. Wide enough to hold the
 * enclosing function in most files, small enough that a round of annotations
 * stays a readable ledger rather than a copy of the repository.
 */
export const CONTEXT_RADIUS = 30;

/** What the reviewer marked: a line range when the browser captured one, plus the text itself. */
export type ContextTarget = { selected_text: string } & AnchorFields;

/**
 * Code around an annotation, cut so the ledger reads without the repository.
 * Pure: the caller picks `fileText` and passes `undefined` when git has none.
 * Anchor wins (it says exactly which lines); else the selected text is located
 * in the file, and an unfindable selection (stale tab, edited since, gutter
 * text) stores nothing rather than a guess.
 */
export function sliceContext(fileText: string | undefined, target: ContextTarget): ContextFields {
  if (fileText === undefined || fileText === "") return { context_source: "none" };
  const lines = fileText.split("\n");
  const anchored = anchoredRange(target, lines.length);
  if (anchored) return { context: cut(lines, anchored), context_source: "anchor" };
  const found = searchedRange(lines, target.selected_text);
  if (found) return { context: cut(lines, found), context_source: "search" };
  return { context_source: "none" };
}

/** A 1-based, inclusive line range that is known to exist in the file. */
interface LineRange {
  start: number;
  end: number;
}

/**
 * The anchor's own range, clamped to the file. Nothing upstream of here checks
 * the numbers against a real file: `parseFeedbackRequest` only knows they are
 * integers ≥ 1, and the file may have changed since the browser read it.
 */
function anchoredRange(target: ContextTarget, count: number): LineRange | undefined {
  if (target.side === undefined) return undefined;
  const start = Math.min(Math.max(target.line_start, 1), count);
  return { start, end: Math.min(Math.max(target.line_end, start), count) };
}

/**
 * Where the selection sits in the file, found by its first non-blank line.
 * Matching a substring rather than a whole line keeps a selection that starts
 * mid-line, or that the browser trimmed of its indentation, locatable.
 */
function searchedRange(lines: string[], selectedText: string): LineRange | undefined {
  const selected = selectedText.split("\n");
  const needle = selected.find((line) => line.trim() !== "")?.trim();
  if (needle === undefined) return undefined;
  const index = lines.findIndex((line) => line.includes(needle));
  if (index === -1) return undefined;
  const start = index + 1;
  return { start, end: Math.min(start + selected.length - 1, lines.length) };
}

function cut(lines: string[], range: LineRange): string {
  return lines
    .slice(Math.max(range.start - 1 - CONTEXT_RADIUS, 0), range.end + CONTEXT_RADIUS)
    .join("\n");
}
