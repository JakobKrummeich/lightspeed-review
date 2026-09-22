import type { DiffFile } from "./diff-extract.ts";

/**
 * What a file git paired with an earlier one is, decided once for every reader
 * of it — the chapter card, the diff header, the classifier and the rounds.
 * Pure, and imports nothing of node's or of the page's: the browser bundle
 * reads it, and so do the ledger and the rounds, which never draw anything.
 */

/** The reviewer's word for where a file's text came from. */
export type Relocation = "moved" | "renamed" | "copied";

/**
 * `copied` when git said so; `moved` when a renamed file left its directory
 * and `renamed` when only its name changed. Git calls both of the last two a
 * rename, and a reviewer reading `useGroupPages.ts` under `renamed from
 * screens/usePresenterGroupWorkScreen.ts` had to compare two long paths to
 * learn that it moved. Decided by status, not by the presence of an earlier
 * name: a session written before copies were told apart stored one as
 * `modified` with a `previousPath`, and read back it is not moved anywhere.
 * Undefined for a file that was where it is.
 */
export function relocationOf(
  file: Pick<DiffFile, "status" | "path" | "previousPath">,
): Relocation | undefined {
  if (file.previousPath === undefined) return undefined;
  if (file.status === "copied") return "copied";
  if (file.status !== "renamed") return undefined;
  return directoryOf(file.previousPath) === directoryOf(file.path) ? "renamed" : "moved";
}

/**
 * The word for a relocation with nothing on top of it — git scored it 100%
 * identical, no line changed, and the mode held — or undefined for every
 * other file. Read by the classifier (mechanical) and by both renderings (the
 * word alone, no `+0 −0`; the sentence in place of an empty diff).
 *
 * The mode is checked in the patch because the counts never see it: `git mv`
 * with a `chmod +x` is `similarity index 100%` over `old mode 100644` /
 * `new mode 100755` and no hunks, and a file made executable is a change to
 * read, not a move to wave through.
 */
export function unchangedRelocationOf(file: DiffFile): Relocation | undefined {
  const relocation = relocationOf(file);
  if (relocation === undefined || !isUnchanged(file)) return undefined;
  return relocation;
}

function isUnchanged(file: DiffFile): boolean {
  return (
    file.similarity === 100 &&
    file.insertions === 0 &&
    file.deletions === 0 &&
    !/^old mode /m.test(file.diff)
  );
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
