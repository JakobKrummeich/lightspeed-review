/**
 * 08 Hyperspace, rounds 2 and later: the opening's room takes the whole
 * window before the new round is drawn (`arrivals().jump()`, from the round's
 * arrival in `session-events.ts`), the round swaps in under it, the stars
 * jump, a flash, and the reviewer lands on the new round — where the replay
 * overlay then opens (`onLanding`).
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
import { caretReturn } from "./caret-return.ts";
import { holdPageBehind } from "./page-hold.ts";
import { claimRoom, evictRoom, leaveRoom } from "./room-claim.ts";
import { paintSky, type SkyPainter } from "./starfield-canvas.ts";
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
  const view = { width: window.innerWidth, height: window.innerHeight };
  const painter = canvas ? paint(canvas, layoutSky([], view), view, false) : undefined;
  painter?.jump();
  return painter;
}

export function playJump(host: JumpHost): void {
  // The room before this one leaves first, by its own way out: it hands the
  // page and the caret back, and only then is either taken.
  evictRoom(host.root);
  if (host.still.reducedMotion || host.still.forcedColors) return host.land();
  // The round is drawn under the room: the caret's box may be redrawn by the landing.
  const caretBack = caretReturn(document.activeElement);
  host.root.innerHTML = ROOM;
  const release = holdPageBehind(host.root);
  let painter: SkyPainter | undefined;
  let flash: ReturnType<typeof setTimeout> | undefined = undefined;
  let done: ReturnType<typeof setTimeout> | undefined = undefined;
  // Runs once: every way in — the timer, Esc, the next room, a mount that
  // failed — is taken down here before the page gets anything back. Declared
  // before anything that can throw, so every way in finds it whole.
  const land = (): void => {
    clearTimeout(flash);
    clearTimeout(done);
    painter?.stop();
    document.removeEventListener("keydown", onKey, true);
    leaveRoom(host.root, land);
    host.root.innerHTML = "";
    release();
    caretBack({ preventScroll: true });
    host.land();
  };
  // Captured and kept: the page is out of reach, so no key of its own may act either.
  const onKey = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === "Escape") land();
  };
  claimRoom(host.root, land);
  document.addEventListener("keydown", onKey, true);
  try {
    painter = jumpStars(host.root, host.paint ?? paintSky);
  } catch (error) {
    // The round is not held back by its decoration.
    console.error("lightspeed: the round jump could not start", error);
    return land();
  }
  const field = host.root.querySelector<HTMLElement>(".lsr-jump-overlay");
  flash = setTimeout(() => {
    if (field) field.dataset.bloom = "true";
  }, SKY_TIMES.flashAtMs);
  done = setTimeout(land, SKY_TIMES.jumpMs);
}

export interface Arrivals {
  /**
   * A new round is arriving: the jump starts now, before the page draws the
   * round, so the swap happens under the room. At once for a still reviewer.
   */
  jump(): void;
  /**
   * Runs `next` as the jump in flight lands — the latest asked wins, since a
   * newer round's replay supersedes an older one's — or at once with none.
   */
  onLanding(next: () => void): void;
  /**
   * A newer round is arriving: what an older one queued for the landing is
   * dropped, jump or not, so its replay never opens over the newer round.
   */
  forget(): void;
  /** A jump is in flight: its landing will open what follows it. */
  jumping(): boolean;
}

/**
 * The page's rounds arriving through `root`. Stillness is asked on every
 * jump, since the preference can change under an open page. Each jump is
 * numbered: a jump the next one evicts lands too, and must not end the
 * newer one's flight.
 */
export function arrivals(root: HTMLElement, still: () => Stillness): Arrivals {
  let flights = 0;
  /** The flight the page is in, or 0 when it is on the ground. */
  let inFlight = 0;
  let next: (() => void) | undefined;
  const landed = (flight: number): void => {
    if (flight !== inFlight) return;
    inFlight = 0;
    const then = next;
    next = undefined;
    then?.();
  };
  return {
    jump() {
      flights += 1;
      const flight = flights;
      inFlight = flight;
      playJump({ root, still: still(), land: () => landed(flight) });
    },
    onLanding(then) {
      if (inFlight === 0) then();
      else next = then;
    },
    forget() {
      next = undefined;
    },
    jumping: () => inFlight !== 0,
  };
}
