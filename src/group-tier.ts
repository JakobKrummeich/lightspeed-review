/**
 * How much reading a chapter is worth, and the one place that reads it. Its own
 * module rather than a corner of `diff-extract.ts`, because the browser is the
 * half of the tool that draws the answer and `diff-extract.ts` shells out to
 * git: a runtime import of that file from a page module pulls `node:child_process`
 * into the bundle, so anything both halves execute has to live somewhere neither
 * of them runs a subprocess from.
 */

/**
 * `study` is everything a human has to judge; `sweep` is a chapter whose every
 * file is bulk — renames, moves, generated output, formatting, documentation,
 * styling, translation catalogues — where reading line by line buys the reviewer
 * nothing. Two tiers and not a scale: the reviewer either reads a chapter or
 * ticks it, and a middle value would be a chapter nobody could say what to do
 * with.
 */
export type GroupTier = "study" | "sweep";

/**
 * The one reading of the tier, so absence means the same thing everywhere: a
 * chapter is swept only when it says so. Anything else — a session written
 * before tiers existed, a fallback grouping, a group some future code builds by
 * hand — is read, which is the direction a wrong guess is survivable in.
 */
export function isSweep(group: { tier?: GroupTier }): boolean {
  return group.tier === "sweep";
}

/**
 * The whole review in one reading order: the chapters to study as the grouping
 * left them, then every swept chapter, in theirs. Stable on both halves,
 * because the order within a tier is a judgement something already made — the
 * model's for the chapters it wrote, `trailTests`' for the checks it parks at
 * the end — and sinking the bulk is no reason to have a second opinion about it.
 *
 * Ordered in the array, once, upstream of every renderer, and never re-sorted
 * by one of them: the survey, the header bar and the chapter on screen all name
 * a chapter by its place in this array (`data-group-index`), so a renderer that
 * sorted for itself would make one number mean two different chapters. The
 * survey has drawn the bulk below the reading since its lane shipped; now the
 * array says the same, so the bar, the lane, "Chapter 2 of 4", Previous/Next
 * and the chapter a finished one moves on to cannot disagree about where a
 * swept chapter is.
 *
 * Typed on the tier alone, like `isSweep` above it: where a chapter goes is a
 * fact about its tier and nothing else, and a signature naming `DiffGroup`
 * would tie the answer to the half of the tool that reads git.
 */
export function trailSweeps<T extends { tier?: GroupTier }>(groups: T[]): T[] {
  return [...groups.filter((group) => !isSweep(group)), ...groups.filter(isSweep)];
}
