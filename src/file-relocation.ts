import type { DiffFile } from "./diff-extract.ts";

/**
 * What a file that carries `previousPath` is, decided once for every reader of
 * it — the chapter card, the diff header, the grouping prompt and the rounds.
 * Pure and import-free on purpose: the browser bundle reads it too.
 */

/**
 * The name a renamed file had before, or undefined for every other file —
 * copies included. A copy carries `previousPath` like a rename, but its source
 * is still in the review under its own name: following the copy's
 * `previousPath` through the rounds handed a brand-new file its source's
 * approval (`settled`) and its source's comments (`currentName`).
 */
export function renamedFrom(file: Pick<DiffFile, "status" | "previousPath">): string | undefined {
  return file.status === "renamed" ? file.previousPath : undefined;
}
