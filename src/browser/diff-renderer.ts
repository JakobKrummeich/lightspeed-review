/** One method, so swapping diff2html (or unit-testing the view without a DOM) stays cheap. */
export interface DiffRenderer {
  /** `diff` includes the file header. */
  renderFile(diff: string): string;
}
