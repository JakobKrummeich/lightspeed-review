/**
 * Warp Send: what went out squeezes into streaks that shoot into the button
 * that sent it, and the button flares (`css/light.css`). The streaks are
 * copies laid over the page at the drafts' places, measured before the panel
 * redraws them away: the send has already happened, and the redraw runs at
 * once underneath, so the light never holds either up.
 */
import { play, spark } from "./light-play.ts";

const MOMENT_MS = 1300;
const STAGGER_MS = 70;
/** A tray of forty pills is one burst of light, not forty. */
const MOST_GHOSTS = 8;

interface Point {
  x: number;
  y: number;
}

/**
 * Every box is read before anything is written: the flare and the layer are
 * writes, and a read after one makes the browser lay the page out again.
 */
export function warpSend(root: HTMLElement, ended: boolean): void {
  const button = root.querySelector<HTMLElement>(ended ? "#lsr-send-end" : "#lsr-send");
  if (!button) return;
  const box = button.getBoundingClientRect();
  const target = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const drafts = draftsOf(root).slice(0, MOST_GHOSTS);
  play(button, "flare", MOMENT_MS);
  if (drafts.length === 0) return;
  const layer = spark(document.body, "lsr-warp-layer", MOMENT_MS);
  // Copies of live controls: out of the Tab order and out of reach, not only out of sight.
  layer.inert = true;
  drafts.forEach((draft, at) => ghost(layer, draft, target, at));
}

interface Draft {
  element: HTMLElement;
  box: DOMRect;
}

/**
 * What the reviewer sees go: the loose draft cards, the reply bubbles inside
 * thread cards, and the words in the box. Only what is on screen: a streak
 * from somewhere scrolled away is light from nowhere.
 */
function draftsOf(root: HTMLElement): Draft[] {
  const cards = [...root.querySelectorAll<HTMLElement>(".lsr-pill")];
  const bubbles = [...root.querySelectorAll<HTMLElement>(".lsr-draft")].filter(
    (bubble) => bubble.closest(".lsr-pill") === null,
  );
  const typedBox = root.querySelector<HTMLTextAreaElement>("#lsr-general-comment");
  const typed = typedBox && typedBox.value.trim() !== "" ? [typedBox] : [];
  return [...cards, ...bubbles, ...typed]
    .map((element) => ({ element, box: element.getBoundingClientRect() }))
    .filter(({ box }) => box.height > 0 && box.bottom > 0 && box.top < window.innerHeight);
}

/** Streaks from its right edge, which is the side the button is on. */
function ghost(layer: HTMLElement, { element, box }: Draft, target: Point, at: number): void {
  const shell = spark(layer, "lsr-warp-ghost", MOMENT_MS, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    "--lsr-warp-dx": `${target.x - box.right}px`,
    "--lsr-warp-dy": `${target.y - (box.top + box.height / 2)}px`,
    "--lsr-warp-delay": `${at * STAGGER_MS}ms`,
  });
  shell.append(copyOf(element));
}

/**
 * A copy of the box would carry its id, and two `#lsr-general-comment`s is one
 * too many for the one second they would share the page: its words are drawn
 * as the bubble they are about to become instead.
 */
function copyOf(draft: HTMLElement): Node {
  if (!(draft instanceof HTMLTextAreaElement)) return withoutIds(draft.cloneNode(true) as Element);
  const bubble = document.createElement("div");
  bubble.className = "lsr-message lsr-draft";
  bubble.textContent = draft.value;
  return bubble;
}

/** A pill's Remove button and the like carry ids the live panel still holds. */
function withoutIds(copy: Element): Element {
  for (const named of [copy, ...copy.querySelectorAll("[id]")]) named.removeAttribute("id");
  return copy;
}
