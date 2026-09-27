/**
 * 08 Hyperspace, rounds 2 and later: the opening's room takes the whole
 * window, the stars jump, a flash covers the swap, and the reviewer lands on
 * the new round — where the replay overlay then opens as it always has.
 * About a second, decorative from end to end (`aria-hidden`, no focus taken),
 * and skipped outright for a reviewer who asked for stillness or forced
 * colours: they land at once. Esc lands at once too.
 *
 * Drawn into the opening's root, which a round can reach while the opening is
 * still up (another tab moved the review on): the opening is closed by its
 * own way out first (`room-claim.ts`), never wiped. While the jump plays the
 * page behind it is inert and no key reaches it — a popup's Esc included.
 */
import { SKY_TIMES, layoutSky } from "../starfield.ts";
import { holdPageBehind } from "./page-hold.ts";
import { claimRoom, evictRoom, leaveRoom } from "./room-claim.ts";
import { paintSky } from "./starfield-canvas.ts";
import type { Stillness } from "./stillness.ts";

export interface JumpHost {
  root: HTMLElement;
  still: Stillness;
  /** The new round is under the flash: open what follows the jump. Called exactly once. */
  land(): void;
  /** The canvas painter; a test hands in its own. */
  paint?: typeof paintSky;
}

const ROOM = `<div class="lsr-jump-overlay" aria-hidden="true" data-bloom="false">
<canvas class="lsr-sky-canvas"></canvas>
<span class="lsr-sky-tunnel"></span>
<span class="lsr-jump-bloom"></span>
</div>`;

/** Mounts the room's stars: no files of its own, the field is all deep stars rushing past. */
function jumpStars(root: HTMLElement, paint: typeof paintSky): ReturnType<typeof paintSky> {
  const canvas = root.querySelector<HTMLCanvasElement>(".lsr-sky-canvas");
  const view = { width: window.innerWidth || 0, height: window.innerHeight || 0 };
  const painter = canvas ? paint(canvas, layoutSky([], view), view, false) : undefined;
  painter?.jump();
  return painter;
}

export function playJump(host: JumpHost): void {
  if (host.still.reducedMotion || host.still.forcedColors) {
    evictRoom(host.root);
    return host.land();
  }
  const leave = (): void => land();
  claimRoom(host.root, leave);
  const before = document.activeElement;
  host.root.innerHTML = ROOM;
  const release = holdPageBehind(host.root);
  const field = host.root.querySelector<HTMLElement>(".lsr-jump-overlay");
  const painter = jumpStars(host.root, host.paint ?? paintSky);
  let landed = false;

  function land(): void {
    if (landed) return;
    landed = true;
    clearTimeout(flash);
    clearTimeout(done);
    painter?.stop();
    document.removeEventListener("keydown", onKey, true);
    leaveRoom(host.root, leave);
    host.root.innerHTML = "";
    release();
    if (before instanceof HTMLElement) before.focus({ preventScroll: true });
    host.land();
  }
  // Captured and kept: the page is out of reach, so no key of its own may act either.
  const onKey = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === "Escape") land();
  };
  const flash = setTimeout(() => {
    if (field) field.dataset.bloom = "true";
  }, SKY_TIMES.flashAtMs);
  const done = setTimeout(land, SKY_TIMES.jumpMs);
  document.addEventListener("keydown", onKey, true);
}

export interface Arrivals {
  /** Jumps into the new round, then `land`s — at once for a still reviewer. */
  play(land: () => void): void;
  /** A jump is in flight: its landing will open what follows it. */
  jumping(): boolean;
}

/**
 * The page's rounds arriving through `root`. Stillness is asked on every
 * jump, since the preference can change under an open page.
 */
export function arrivals(root: HTMLElement, still: () => Stillness): Arrivals {
  let inFlight = false;
  return {
    play(land) {
      inFlight = true;
      playJump({
        root,
        still: still(),
        land: () => {
          inFlight = false;
          land();
        },
      });
    },
    jumping: () => inFlight,
  };
}
