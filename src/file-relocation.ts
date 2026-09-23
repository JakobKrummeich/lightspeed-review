import type { DiffFile } from "./diff-extract.ts";

export type Relocation = "moved" | "renamed";

/**
 * Git calls a move and a rename both a rename; the reviewer had to compare two
 * long paths to learn a file left its directory. Keyed on status, not on the
 * presence of `previousPath`: a session written before `src/diff-extract.ts`
 * stopped asking git for copies stored one as `modified` with a `previousPath`.
 */
export function relocationOf(
  file: Pick<DiffFile, "status" | "path" | "previousPath">,
): Relocation | undefined {
  if (file.previousPath === undefined) return undefined;
  if (file.status !== "renamed") return undefined;
  return directoryOf(file.previousPath) === directoryOf(file.path) ? "renamed" : "moved";
}

export function unchangedRelocationOf(file: DiffFile): Relocation | undefined {
  const relocation = relocationOf(file);
  if (relocation === undefined || !isUnchanged(file)) return undefined;
  return relocation;
}

/**
 * The mode is checked in the patch because the counts never see it: `git mv`
 * with a `chmod +x` is `similarity index 100%` over `old mode 100644` /
 * `new mode 100755` and no hunks, and a file made executable is a change to
 * read, not a move to wave through.
 */
function isUnchanged(file: DiffFile): boolean {
  return (
    file.similarity === 100 &&
    file.insertions === 0 &&
    file.deletions === 0 &&
    !/^old mode /m.test(file.diff)
  );
}

/**
 * Keyed on status, not on `previousPath`: sessions written while
 * `src/diff-extract.ts` still asked git for copies hold ≥50%-similar copies as
 * `modified` with a `previousPath`, and following that name through the rounds
 * handed a brand-new file its source's approval (`settled`) and its comments
 * (`currentName`).
 */
export function renamedFrom(file: Pick<DiffFile, "status" | "previousPath">): string | undefined {
  return file.status === "renamed" ? file.previousPath : undefined;
}

/** No `node:path`: the browser reads this too. */
function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}
