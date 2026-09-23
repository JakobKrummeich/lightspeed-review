import type { HLJSApi } from "highlight.js";
import { highlightSide } from "./syntax-lines.ts";

export interface FileHighlight {
  /** One entry per file line. */
  html: string[];
  text: string[];
}

export interface DiffRow {
  /** 1-based; undefined on the other version's rows. */
  number: number | undefined;
  text: string;
}

/**
 * The point of reading files instead of hunks: highlight.js decides what a
 * fragment means from the code around it, so a JSX element, a block comment or
 * a template literal that a hunk cuts in half can only be coloured correctly
 * from the complete text.
 */
export function highlightFile(
  hljs: HLJSApi,
  language: string,
  contents: string,
): FileHighlight | undefined {
  const text = contents.split("\n");
  const html = highlightSide(hljs, language, text);
  return html && { html, text };
}

/**
 * Undefined when the file cannot account for the row: any of no line number,
 * a number past the end, or differing text means the file we fetched is not
 * the one on screen — a stale commit, a rename, an amended branch — and
 * painting anyway would put one line's colours on another.
 */
export function htmlForRow(file: FileHighlight, row: DiffRow): string | undefined {
  if (row.number === undefined) return undefined;
  const index = row.number - 1;
  const text = file.text[index];
  if (text === undefined || !sameCode(text, row.text)) return undefined;
  return file.html[index];
}

/**
 * diff2html renders leading and repeated spaces as non-breaking ones, and a
 * file may still carry CR line endings, so neither is a real difference.
 */
function sameCode(fileLine: string, rowText: string): boolean {
  return normalize(fileLine) === normalize(rowText);
}

function normalize(line: string): string {
  return line.replaceAll("\u00a0", " ").replace(/\r$/, "");
}
