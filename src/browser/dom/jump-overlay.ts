/**
 * 08 Hyperspace, rounds 2 and later: the opening's room takes the whole
 * window, the stars jump, a flash covers the swap, and the reviewer lands on
 * the new round — where the replay overlay then opens as it always has.
 * About a second, decorative from end to end (`aria-hidden`, no focus taken),
 * and skipped outright for a reviewer who asked for stillness or forced
 * colours: they land at once. Esc lands at once too.
 *
 * Drawn into the opening's root: the opening is a first round's and the
 * replay a later round's, so the two never want the root at the same time.
 */
import { SKY_TIMES, layoutSky } from "../starfield.ts";
import { paintSky } from "./starfield-canvas.ts";
import type { Stillness } from "./stillness.ts";

export interface JumpHost {
  root: HTMLElement;
  still: Stillness;
  /** The new round is under the flash: open what follows the jump. Called exactly once. */
  land(): void;
}

const ROOM = `<div class="lsr-jump-overlay" aria-hidden="true" data-bloom="false">
<canvas class="lsr-sky-canvas"></canvas>
<span class="lsr-sky-tunnel"></span>
<span class="lsr-jump-bloom"></span>
</div>`;

export function playJump(host: JumpHost): void {
  if (host.still.reducedMotion || host.still.forcedColors) return host.land();
  host.root.innerHTML = ROOM;
  const field = host.root.querySelector<HTMLElement>(".lsr-jump-overlay");
  const canvas = host.root.querySelector<HTMLCanvasElement>(".lsr-sky-canvas");
  const view = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
  // No files of its own: the field is all deep stars, rushing past.
  const painter = canvas && paintSky(canvas, layoutSky([], view), view, false);
  painter?.jump();
  let landed = false;

  const land = (): void => {
    if (landed) return;
    landed = true;
    clearTimeout(flash);
    clearTimeout(done);
    painter?.stop();
    document.removeEventListener("keydown", onKey);
    host.root.innerHTML = "";
    host.land();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") land();
  };
  const flash = setTimeout(() => {
    if (field) field.dataset.bloom = "true";
  }, SKY_TIMES.flashAtMs);
  const done = setTimeout(land, SKY_TIMES.jumpMs);
  document.addEventListener("keydown", onKey);
}
