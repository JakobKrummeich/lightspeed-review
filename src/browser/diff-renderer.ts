/**
 * The seam between grouped session data and whatever draws a unified diff.
 * diff2html is the MVP implementation; keeping the surface to one method is
 * what makes swapping it (or unit-testing the view without a DOM) cheap.
 */
export interface DiffRenderer {
  /** Takes one file's unified diff (header included) and returns HTML. */
  renderFile(diff: string): string;
}
