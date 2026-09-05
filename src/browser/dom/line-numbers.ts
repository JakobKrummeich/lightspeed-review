import type { SelectedLine } from "../annotation.ts";

/**
 * The numbers diff2html printed for one rendered line. Side by side each column
 * carries its own gutter, so which column the line sits in decides the version;
 * unified, both numbers share one cell and the empty one marks a line that
 * belongs to the other version only.
 *
 * The single place that knows the gutter markup: line anchors and whole-file
 * highlighting both hang off these numbers.
 */
export function lineNumbers(line: Element, columns: Element[]): SelectedLine {
  const row = line.closest("tr");
  if (!row) return {};
  if (columns.length === 0) {
    return { old: printedNumber(row, ".line-num1"), new: printedNumber(row, ".line-num2") };
  }
  // A line of a side-by-side file that sits in neither column has no version to
  // belong to; reading the unified gutter there would invent a number.
  const column = columns.findIndex((candidate) => candidate.contains(line));
  if (column === -1) return {};
  const number = printedNumber(row, ".d2h-code-side-linenumber");
  return column === 0 ? { old: number } : { new: number };
}

/** The columns of a side-by-side file, empty when the file is rendered unified. */
export function sideColumns(file: Element): Element[] {
  return [...file.querySelectorAll(".d2h-file-side-diff")];
}

/** One line of one version of a file: where a stored anchor points. */
export interface LinePlace {
  side: "old" | "new";
  line: number;
}

/**
 * The rendered line a place points at, or nothing when the diff on screen no
 * longer prints it. The inverse of `lineNumbers`, walked over the same
 * elements a selection walks, so an anchor read off a selection here is found
 * by the very numbers it was written from — unified or side by side alike.
 */
export function findLine(file: Element, place: LinePlace): Element | undefined {
  const columns = sideColumns(file);
  for (const line of file.querySelectorAll(".d2h-code-line, .d2h-code-side-line")) {
    if (lineNumbers(line, columns)[place.side] === place.line) return line;
  }
  return undefined;
}

function printedNumber(row: Element, selector: string): number | undefined {
  const number = Number.parseInt(row.querySelector(selector)?.textContent?.trim() ?? "", 10);
  return Number.isNaN(number) ? undefined : number;
}
