import type { DiffFile } from "./diff-extract.ts";
import { escapeHtml } from "./escape-html.ts";

/**
 * What a file that carries `previousPath` is, decided once for every reader of
 * it — the chapter card, the diff header, the classifier and the rounds.
 * Pure, and imports nothing of node's: the browser bundle reads it too.
 */

/** The reviewer's word for where a file's text came from. */
export type Relocation = "moved" | "renamed" | "copied";

/**
 * `copied` when git said so; otherwise `moved` when the file left its
 * directory and `renamed` when only its name changed. Git calls both of the
 * last two a rename, and a reviewer reading `useGroupPages.ts` under
 * `renamed from screens/usePresenterGroupWorkScreen.ts` had to compare two
 * long paths to learn that it moved. Undefined for a file that was where it is.
 */
export function relocationOf(
  file: Pick<DiffFile, "status" | "path" | "previousPath">,
): Relocation | undefined {
  if (file.previousPath === undefined) return undefined;
  if (file.status === "copied") return "copied";
  return directoryOf(file.previousPath) === directoryOf(file.path) ? "renamed" : "moved";
}

/**
 * A relocation git scored 100% identical with no line changed on top of it:
 * the patch is a header, and the path is the whole of the change. Read by the
 * classifier (mechanical) and by both renderings (the word alone, no `+0 −0`).
 */
export function isUnchangedRelocation(file: DiffFile): boolean {
  return (
    relocationOf(file) !== undefined &&
    file.similarity === 100 &&
    file.insertions === 0 &&
    file.deletions === 0
  );
}

/**
 * The path as a row names it: `old → new` for a relocated file, the path
 * alone for any other, both escaped. The same on the chapter card and the diff
 * header, so the eye finds the file it read on the card under the same words.
 */
export function pathLabel(file: Pick<DiffFile, "path" | "previousPath">): string {
  const path = escapeHtml(file.path);
  if (file.previousPath === undefined) return path;
  return `${escapeHtml(file.previousPath)} → ${path}`;
}

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

/** Up to and including the last `/`; empty at the repository root. No `node:path`: the browser reads this too. */
function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}
