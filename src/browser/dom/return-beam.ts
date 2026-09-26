/**
 * 03 Return beam: the agent answered (`css/light.css`). The header's turn dot
 * pulses and drops a beam to the first new card in sight; a spark runs once
 * round each new card and its newest answer fades in. A card the reviewer
 * cannot see — the panel folded, or the card scrolled away — gets no beam:
 * the dot's pulse alone says that something arrived.
 */
import { play, spark } from "./light-play.ts";

const MOMENT_MS = 1800;
const PULSE_MS = 900;
/** The beam lands this far inside a card's corner, never on its rounding. */
const CORNER = 12;

/**
 * Every box is measured before anything is lit: lighting sets state, and a
 * read after a write makes the browser lay the page out again to answer it.
 */
export function returnBeam(root: HTMLElement, cards: string[]): void {
  const from = dotBox();
  const lit = cardsInSight(root, cards);
  const target = lit[0]?.getBoundingClientRect();
  if (from) pulse(from);
  for (const card of lit) arrive(card);
  if (from && target && lit[0]) beam(from, lit[0], target);
}

function dotBox(): DOMRect | undefined {
  const box = document.querySelector(".lsr-presence-dot")?.getBoundingClientRect();
  return box && box.width > 0 ? box : undefined;
}

/**
 * Laid over the dot rather than set on it: the status banner redraws the dot
 * a few milliseconds after the answer lands, and would take a state set on
 * the old one away with it before a frame of the pulse was drawn.
 */
function pulse(from: DOMRect): void {
  const light = spark(document.body, "lsr-light-pulse", PULSE_MS, pulseAt(from));
  follow(light, () => {
    const dot = dotBox();
    return dot && pulseAt(dot);
  });
}

function pulseAt(dot: DOMRect): Record<string, string> {
  return {
    left: `${dot.left}px`,
    top: `${dot.top}px`,
    width: `${dot.width}px`,
    height: `${dot.height}px`,
  };
}

/**
 * Keeps a light on the dot for as long as it lasts: the redrawn dot often
 * stands elsewhere along the header, its words having changed. Read, then
 * written, once a frame; over when the light is.
 */
function follow(light: HTMLElement, place: () => Record<string, string> | undefined): void {
  const step = (): void => {
    if (!light.isConnected) return;
    for (const [name, value] of Object.entries(place() ?? {})) light.style.setProperty(name, value);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Matched by `data-key` read back, not a selector: a key is the reviewer's text. */
function cardsInSight(root: HTMLElement, keys: string[]): HTMLElement[] {
  const scroll = root.querySelector<HTMLElement>(".lsr-panel-scroll");
  if (!scroll) return [];
  const view = scroll.getBoundingClientRect();
  return [...root.querySelectorAll<HTMLElement>(".lsr-thread")].filter((card) => {
    if (!keys.includes(card.dataset.key ?? "")) return false;
    const box = card.getBoundingClientRect();
    return box.height > 0 && box.bottom > view.top && box.top < view.bottom;
  });
}

function arrive(card: HTMLElement): void {
  play(card, "arrive", MOMENT_MS);
  const answers = [...card.querySelectorAll<HTMLElement>(".lsr-message")].filter(
    (message) => message.dataset.role === "agent",
  );
  const newest = answers.at(-1);
  if (newest) play(newest, "arrive", MOMENT_MS);
}

/** From the dot to the card, and with them both wherever they go while it lasts. */
function beam(from: DOMRect, card: HTMLElement, box: DOMRect): void {
  const light = spark(document.body, "lsr-light-beam", MOMENT_MS, beamAt(from, box));
  follow(light, () => {
    const dot = dotBox();
    return dot && card.isConnected ? beamAt(dot, card.getBoundingClientRect()) : undefined;
  });
}

/** Aimed at the card's top edge, as straight below the dot as the card allows. */
function beamAt(from: DOMRect, box: DOMRect): Record<string, string> {
  const x = from.left + from.width / 2;
  const y = from.top + from.height / 2;
  const dx = Math.min(Math.max(x, box.left + CORNER), box.right - CORNER) - x;
  const dy = box.top - y;
  return {
    left: `${x - 1}px`,
    top: `${y}px`,
    height: `${Math.hypot(dx, dy)}px`,
    // Drawn pointing down; turned toward the card about its top end.
    "--lsr-beam-turn": `${Math.atan2(-dx, dy)}rad`,
  };
}
