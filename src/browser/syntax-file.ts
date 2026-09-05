import type { HLJSApi } from "highlight.js";
import { highlightSide } from "./syntax-lines.ts";

/** One version of a file, highlighted as a whole and cut back into lines. */
export interface FileHighlight {
  /** Highlighted HTML, one entry per file line, in file order. */
  html: string[];
  /** The same lines as plain text, so a diff row can be checked against them. */
  text: string[];
}

/** A rendered diff row: which line of the file it shows, and what it shows. */
export interface DiffRow {
  /** 1-based line number in this version of the file; undefined on the other version's rows. */
  number: number | undefined;
  text: string;
}

/**
 * Highlights a whole file. This is the point of reading files instead of
 * hunks: highlight.js decides what a fragment means from the code around it,
 * so a JSX element, a block comment or a template literal that a hunk cuts in
 * half can only be coloured correctly from the complete text.
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
 * The highlighted HTML for one diff row, or undefined when the file cannot
 * account for it: no line number, a number past the end, or text that differs
 * from the file's. Any of those means the file we fetched is not the one on
 * screen — a stale commit, a rename, an amended branch — and painting anyway
 * would put one line's colours on another.
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
