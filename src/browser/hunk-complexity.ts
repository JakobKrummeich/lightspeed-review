import type { DiffFile, DiffGroup } from "../diff-extract.ts";
import { collapseWhitespace } from "../classify.ts";
import { isSweep } from "../group-tier.ts";

export const LOGIC_BADGE_LABEL = "densest logic";

/**
 * Deliberately a word list and not a parser: the page must score a change in
 * any language, in the browser, with no grammar and no dependency — and the
 * number only ever ranks the hunks of one review against each other.
 */
const BRANCH_WORDS =
  /\b(if|else|elif|for|while|switch|case|catch|try|finally|do|match|except|unless)\b/g;

const BRANCH_SYMBOLS = /(\?\?|&&|\|\||\?\.)/g;

const ADDED_INDENT = /^\+([ \t]*)/;

/**
 * A line counts as newly written only when nothing on the removed side answers
 * it — the same content once whitespace is collapsed, which is the reading
 * `src/classify.ts` already uses to call a change a reformat, so the two cannot
 * disagree about the same patch. Counting every added line was the badge's own
 * inversion: a reindentation re-adds every `if`, `&&` and `?:` the block always
 * had, deeper than before, so a chapter that decided nothing could be named the
 * densest logic in the review. Subtracting the branches of the removed lines
 * nothing answers covers the other shape of it — a mechanical rename, where no
 * line comes back character-for-character and none of the branching is new either.
 *
 * Removal on its own still scores nothing: a deleted branch is relief, not risk.
 * Not a quality score and no threshold: nothing is hidden and nothing is called bad.
 */
export function addedComplexity(diff: string): number {
  const added = changedLines(diff, "+");
  const removed = changedLines(diff, "-");
  const written = unanswered(added, removed);
  const branches = branchTotal(written) - branchTotal(unanswered(removed, added));
  if (branches <= 0) return 0;
  // Depth counts once, not per line: a long block at one indent is long, not deep.
  return branches + Math.max(0, ...written.map(nestingDepth));
}

/** `+++ b/path` and `--- a/path` are the header, not lines of it. */
function changedLines(diff: string, marker: "+" | "-"): string[] {
  const header = marker.repeat(3);
  return diff.split("\n").filter((line) => line.startsWith(marker) && !line.startsWith(header));
}

/**
 * Multisets rather than sets: a block that comes back holding two copies of a
 * line it removed once has written one of them, and set comparison would call
 * that nothing.
 */
function unanswered(lines: string[], others: string[]): string[] {
  const spare = new Map<string, number>();
  for (const line of others) {
    const key = lineContent(line);
    spare.set(key, (spare.get(key) ?? 0) + 1);
  }
  const left: string[] = [];
  for (const line of lines) {
    const key = lineContent(line);
    const answers = spare.get(key) ?? 0;
    if (answers === 0) left.push(line);
    else spare.set(key, answers - 1);
  }
  return left;
}

function lineContent(line: string): string {
  return collapseWhitespace(line.slice(1));
}

function branchTotal(lines: string[]): number {
  return lines.reduce((total, line) => total + branchCount(line), 0);
}

function branchCount(line: string): number {
  return (line.match(BRANCH_WORDS)?.length ?? 0) + (line.match(BRANCH_SYMBOLS)?.length ?? 0);
}

export function fileComplexity(file: DiffFile): number {
  return file.status === "binary" ? 0 : addedComplexity(file.diff);
}

export function groupComplexity(group: DiffGroup): number {
  return group.files.reduce((total, file) => total + fileComplexity(file), 0);
}

/** Ties all mark: choosing between equals invents a difference. */
export function heaviestFiles(group: DiffGroup): string[] {
  const scored = group.files.map((file) => ({ path: file.path, score: fileComplexity(file) }));
  const top = Math.max(0, ...scored.map((entry) => entry.score));
  if (top === 0) return [];
  return scored.filter((entry) => entry.score === top).map((entry) => entry.path);
}

/**
 * Never a swept chapter, whatever it scores. The lane a swept chapter sits in
 * is the survey saying there is nothing to decide there and offering one press
 * for the lot; a badge inside it is the same screen giving two orders, and the
 * one it shouts is the one it meant the reviewer to skip. A swept chapter that
 * genuinely holds the review's densest logic is a chapter tiered wrong, and the
 * repair for that is its tier — a mark sending the reviewer to read what the
 * page just told them not to would hide the miscall rather than show it.
 */
export function heaviestGroups(groups: DiffGroup[]): number[] {
  const scores = groups.map((group) => (isSweep(group) ? 0 : groupComplexity(group)));
  const top = Math.max(0, ...scores);
  if (top === 0) return [];
  return scores.flatMap((score, index) => (score === top ? [index] : []));
}

function nestingDepth(line: string): number {
  const indent = ADDED_INDENT.exec(line)?.[1] ?? "";
  return Math.floor(indent.replace(/\t/g, "  ").length / 2);
}
