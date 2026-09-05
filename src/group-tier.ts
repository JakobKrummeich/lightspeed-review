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
