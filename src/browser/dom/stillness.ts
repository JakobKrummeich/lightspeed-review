/**
 * The two preferences every light moment answers. Asked each time, not once:
 * either can change under an open page.
 */
export interface Stillness {
  /** Every moment lands on its end state, with no movement. */
  reducedMotion: boolean;
  /** No decorative canvas: the system paints the page, and a drawn sky would ignore it. */
  forcedColors: boolean;
}

export function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function stillness(): Stillness {
  return {
    reducedMotion: reducedMotion(),
    forcedColors: window.matchMedia("(forced-colors: active)").matches,
  };
}
