/**
 * Its own module rather than a corner of `diff-extract.ts`: that file shells out
 * to git, and a runtime import of it from a page module pulls
 * `node:child_process` into the browser bundle.
 */

/**
 * `sweep` is a chapter whose every file is bulk — renames, moves, generated
 * output, formatting, documentation, styling, translation catalogues — where
 * reading line by line buys the reviewer nothing; `study` is everything else.
 * Two tiers and not a scale: the reviewer either reads a chapter or ticks it,
 * and a middle value would be a chapter nobody could say what to do with.
 */
export type GroupTier = "study" | "sweep";

/**
 * Absence reads as `study`: a session written before tiers existed, a fallback
 * grouping, a group built by hand — all are read, which is the direction a
 * wrong guess is survivable in.
 */
export function isSweep(group: { tier?: GroupTier }): boolean {
  return group.tier === "sweep";
}

/**
 * Stable within each tier: the order there is a judgement something already
 * made — the model's for the chapters it wrote, `trailTests`' for the checks it
 * parks at the end. Ordered once, upstream of every renderer, and never
 * re-sorted by one of them: the survey, the header bar and the chapter on
 * screen all name a chapter by its place in this array (`data-group-index`),
 * so a renderer that sorted for itself would make one number mean two
 * different chapters.
 */
export function trailSweeps<T extends { tier?: GroupTier }>(groups: T[]): T[] {
  return [...groups.filter((group) => !isSweep(group)), ...groups.filter(isSweep)];
}
