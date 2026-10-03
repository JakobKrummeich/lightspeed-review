/**
 * Which chapter a press on a focus control asks for: the index entries, the
 * focus bar's exit/prev/next and the header's progress segments. Decoding
 * only — the diff mount decides what the answer does to the page.
 */

const FOCUS_CONTROLS = ["lsr-index-entry", "lsr-focus-exit", "lsr-focus-prev", "lsr-focus-next"];

export function isFocusControl(target: HTMLElement): boolean {
  return FOCUS_CONTROLS.some((name) => target.classList.contains(name));
}

/**
 * Wrapped rather than bare: "to the overview" is undefined and so is
 * "nowhere", and `Number` on a missing attribute would read 0 and focus the
 * wrong chapter.
 */
export function focusPress(
  target: HTMLElement,
  focus: number | undefined,
  count: number,
): { to: number | undefined } | undefined {
  if (target.classList.contains("lsr-focus-exit")) return { to: undefined };
  if (target.classList.contains("lsr-index-entry")) return indexPress(target);
  if (focus === undefined) return undefined;
  if (target.classList.contains("lsr-focus-prev")) return step(focus, -1, count);
  if (target.classList.contains("lsr-focus-next")) return step(focus, 1, count);
  return undefined;
}

/**
 * The disabled ends never fire, but if one did, the clamp would read -1 as
 * "leave focus mode".
 */
function step(focus: number, by: number, count: number): { to: number } | undefined {
  const to = focus + by;
  return to >= 0 && to < count ? { to } : undefined;
}

export function indexPress(target: HTMLElement): { to: number } | undefined {
  const index = Number(target.dataset.groupIndex);
  return Number.isInteger(index) ? { to: index } : undefined;
}
