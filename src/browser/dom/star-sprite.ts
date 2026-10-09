/**
 * The sky's inks and the one star sprite drawn in them, for the painter in
 * `./starfield-canvas.ts`. Its own module because the painter stands at the
 * 300-line ceiling; this is the part of it that reads the page rather than
 * drawing frames, and it runs once per scheme, not once per frame.
 */

const SPRITE_RADIUS = 24;

export interface Ink {
  accent: string;
  core: string;
  night: boolean;
}

/**
 * The tokens resolved through a probe, because a custom property reads back as
 * its `light-dark()` text, not the colour the page is painting.
 */
export function inkOf(canvas: HTMLCanvasElement): Ink {
  const probe = document.createElement("span");
  probe.hidden = true;
  canvas.after(probe);
  const read = (token: string): string => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const ink = {
    accent: read("--lsr-accent"),
    core: read("--lsr-light-ink"),
    night: document.documentElement.dataset.colorScheme === "dark",
  };
  probe.remove();
  return ink;
}

/** One star, drawn once into a sprite. */
export function sprite(ink: Ink): HTMLCanvasElement {
  const size = SPRITE_RADIUS * 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const r = SPRITE_RADIUS;
  const glow = context.createRadialGradient(r, r, 0, r, r, r);
  const stops: [number, string][] = ink.night
    ? [
        [0, ink.core],
        [0.12, ink.core],
        [0.22, ink.accent],
        [1, "transparent"],
      ]
    : [
        [0, ink.core],
        [0.16, ink.core],
        [0.2, ink.accent],
        [0.32, "transparent"],
        [1, "transparent"],
      ];
  for (const [at, colour] of stops) glow.addColorStop(at, colour);
  context.fillStyle = glow;
  context.fillRect(0, 0, size, size);
  if (!ink.night) {
    context.globalAlpha = 0.14;
    context.fillStyle = ink.accent;
    context.beginPath();
    context.arc(r, r, r * 0.55, 0, Math.PI * 2);
    context.fill();
  }
  return canvas;
}
