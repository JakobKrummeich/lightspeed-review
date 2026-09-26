/**
 * The two ways a light moment touches the page (`css/light.css`): a state set
 * on an element the page already has, and a throwaway element laid in for the
 * moment. Both are taken down on a timer rather than on `animationend`, which
 * never fires where reduced motion has put the animation out: a moment ends
 * whether or not anybody saw it move.
 */

/** The latest moment started on each element: only its own timer may end it. */
const playing = new WeakMap<Element, object>();

/**
 * Sets `data-light` for `ms`. The same moment again restarts it: the flush
 * between taking the state off and putting it back is what a browser needs to
 * see the animation as new, and the earlier moment's timer then ends nothing.
 */
export function play(element: Element, moment: string, ms: number): void {
  if (element.getAttribute("data-light") !== null) {
    element.removeAttribute("data-light");
    void (element as HTMLElement).offsetWidth;
  }
  const run = {};
  playing.set(element, run);
  element.setAttribute("data-light", moment);
  setTimeout(() => {
    if (playing.get(element) === run) element.removeAttribute("data-light");
  }, ms);
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
