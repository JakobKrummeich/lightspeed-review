import type { DiffFile } from "../diff-extract.ts";
import { escapeHtml } from "../escape-html.ts";
import { relocationOf } from "../file-relocation.ts";

/**
 * Shared by the chapter card and the diff header, so the eye finds the file it
 * read on the card under the same words. Which files are relocated is
 * `relocationOf`'s call, not the field's: an earlier name git did not pair the
 * file with is not shown.
 */
export function pathLabel(file: Pick<DiffFile, "status" | "path" | "previousPath">): string {
  const path = escapeHtml(file.path);
  const from = file.previousPath;
  if (from === undefined || relocationOf(file) === undefined) return path;
  return `${escapeHtml(from)} → ${path}`;
}
