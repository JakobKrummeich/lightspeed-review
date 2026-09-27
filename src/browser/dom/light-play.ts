/**
 * The two ways a light moment touches the page (`css/light.css`): a state set
 * on an element the page already has, and a throwaway element laid in for the
 * moment. Both are taken down on a timer rather than on `animationend`, which
 * never fires where reduced motion has put the animation out: a moment ends
 * whether or not anybody saw it move.
 */

/**
 * The latest moment started on each element, with the custom properties it
 * set: only its own timer may end it, and ending it takes those too.
 */
const playing = new WeakMap<Element, { names: string[] }>();

/**
 * Sets `data-light` for `ms`, and `place`'s custom properties with it. The
 * same moment again restarts it: the flush between taking the state off and
 * putting it back is what a browser needs to see the animation as new, and
 * the earlier moment's timer then ends nothing.
 */
export function play(
  element: Element,
  moment: string,
  ms: number,
  place: Record<string, string> = {},
): void {
  if (element.getAttribute("data-light") !== null) {
    stop(element);
    void (element as HTMLElement).offsetWidth;
  }
  const run = { names: Object.keys(place) };
  playing.set(element, run);
  const { style } = element as HTMLElement;
  for (const [name, value] of Object.entries(place)) style.setProperty(name, value);
  element.setAttribute("data-light", moment);
  setTimeout(() => {
    if (playing.get(element) === run) stop(element);
  }, ms);
}

/** Ends the element's moment now, whichever it is, and the properties it set. */
export function stop(element: Element): void {
  const run = playing.get(element);
  playing.delete(element);
  element.removeAttribute("data-light");
  const { style } = element as HTMLElement;
  for (const name of run?.names ?? []) style.removeProperty(name);
}

/**
 * An element that exists for one moment. `place` is where it stands and the
 * custom properties its animation reads, never a colour: those are the
 * stylesheet's, read from the tokens.
 */
export function spark(
  parent: Element,
  className: string,
  ms: number,
  place: Record<string, string> = {},
): HTMLElement {
  const element = document.createElement("span");
  element.className = className;
  element.setAttribute("aria-hidden", "true");
  for (const [name, value] of Object.entries(place)) element.style.setProperty(name, value);
  parent.append(element);
  setTimeout(() => element.remove(), ms);
  return element;
}
