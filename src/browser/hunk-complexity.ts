import type { DiffFile, DiffGroup } from "../diff-extract.ts";
import { collapseWhitespace } from "../classify.ts";
import { isSweep } from "../group-tier.ts";

/** What the badge says wherever it appears: one phrase, two places. */
export const LOGIC_BADGE_LABEL = "densest logic";

/**
 * Branching words worth a point each. Deliberately a word list and not a
 * parser: the page must score a change in any language, in the browser, with no
 * grammar and no dependency — and the number only ever ranks the hunks of one
 * review against each other.
 */
const BRANCH_WORDS =
  /\b(if|else|elif|for|while|switch|case|catch|try|finally|do|match|except|unless)\b/g;

/** Symbolic branches the word list cannot see. */
const BRANCH_SYMBOLS = /(\?\?|&&|\|\||\?\.)/g;

/** The `+` and then one level of nesting per two spaces or per tab. */
const ADDED_INDENT = /^\+([ \t]*)/;

/**
 * How much branching a change *writes*: one point per branch in the lines it
 * newly wrote, less the branches in the lines it took away, plus the deepest
 * nesting those new lines reach.
 *
 * A line counts as newly written only when nothing on the removed side answers
 * it — the same content once whitespace is collapsed, which is the reading
 * `src/classify.ts` already uses to call a change a reformat, so the two cannot
 * disagree about the same patch. Counting every added line was the badge's own
 * inversion: a reindentation re-adds every `if`, `&&` and `?:` the block always
 * had, deeper than before, so a chapter that decided nothing could be named the
 * densest logic in the review. Subtracting the branches of the removed lines
 * nothing answers covers the other shape of it — a mechanical rename, where no
 * line comes back character-for-character and none of the branching is new
 * either.
 *
 * Removal on its own still scores nothing: a deleted branch is relief, not risk,
 * and warning a reviewer about `if`s that no longer exist is warning them about
 * work already done.
 *
 * Not a quality score and no threshold: nothing is hidden and nothing is called
 * bad. It says where the thinking in this review is, from a collapsed group.
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

/** One side of the patch; `+++ b/path` and `--- a/path` are its header, not lines of it. */
function changedLines(diff: string, marker: "+" | "-"): string[] {
  const header = marker.repeat(3);
  return diff.split("\n").filter((line) => line.startsWith(marker) && !line.startsWith(header));
}

/**
 * The lines of one side that no line of the other side answers, as multisets
 * rather than sets: a block that comes back holding two copies of a line it
 * removed once has written one of them, and set comparison would call that
 * nothing.
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

/** A line as its content alone: the marker gone, whitespace no longer a difference. */
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

/**
 * The paths carrying the heaviest added logic in their group. Ties all mark,
 * because choosing between equals invents a difference; a group that added no
 * branching marks nothing.
 */
export function heaviestFiles(group: DiffGroup): string[] {
  const scored = group.files.map((file) => ({ path: file.path, score: fileComplexity(file) }));
  const top = Math.max(0, ...scored.map((entry) => entry.score));
  if (top === 0) return [];
  return scored.filter((entry) => entry.score === top).map((entry) => entry.path);
}

/**
 * The index entries that mark logic: the group holding the most added branching
 * in the whole review. One mark on the map, not one per line of it.
 *
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
