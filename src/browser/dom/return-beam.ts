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

export function returnBeam(root: HTMLElement, cards: string[]): void {
  const dot = document.querySelector<HTMLElement>(".lsr-presence-dot");
  if (dot) play(dot, "pulse", PULSE_MS);
  const lit = cardsInSight(root, cards);
  for (const card of lit) arrive(card);
  if (dot && lit[0]) beam(dot, lit[0]);
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

/** Aimed at the card's top edge, as straight below the dot as the card allows. */
function beam(dot: HTMLElement, card: HTMLElement): void {
  const from = dot.getBoundingClientRect();
  const x = from.left + from.width / 2;
  const y = from.top + from.height / 2;
  const box = card.getBoundingClientRect();
  const dx = Math.min(Math.max(x, box.left + CORNER), box.right - CORNER) - x;
  const dy = box.top - y;
  spark(document.body, "lsr-light-beam", MOMENT_MS, {
    left: `${x - 1}px`,
    top: `${y}px`,
    height: `${Math.hypot(dx, dy)}px`,
    // Drawn pointing down; turned toward the card about its top end.
    "--lsr-beam-turn": `${Math.atan2(-dx, dy)}rad`,
  });
}
