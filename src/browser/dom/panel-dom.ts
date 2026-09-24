/**
 * The panel's elements read and moved by their geometry and data attributes
 * alone: no panel state, no review, no network. Kept apart from the mount so
 * the mount reads as what the panel does, not how a scroll offset is measured.
 */
import type { LinePlace } from "./line-numbers.ts";

/**
 * Scrolled up, a reply must not yank the panel away. Within a line counts as
 * at bottom: rounded scroll positions are off by fractions of a pixel.
 */
export function atBottom(scrollHost: HTMLElement | null): boolean {
  if (scrollHost === null) return true;
  return scrollHost.scrollHeight - scrollHost.scrollTop - scrollHost.clientHeight < 32;
}

export function toBottom(scrollHost: HTMLElement | null): void {
  if (scrollHost) scrollHost.scrollTop = scrollHost.scrollHeight;
}

/**
 * Read off the pressed file button's own data, so a redraw can never leave a
 * handler pointing at a gone comment. Half an anchor is read as none: better
 * the file than a lie.
 */
export function placeOn(target: HTMLElement): LinePlace | undefined {
  const side = target.dataset.side;
  if (side !== "old" && side !== "new") return undefined;
  const line = Number(target.dataset.line);
  return Number.isInteger(line) && line > 0 ? { side, line } : undefined;
}
