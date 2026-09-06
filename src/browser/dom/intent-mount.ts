/**
 * The one press on the intent block: the heading that opens what the change is
 * for, and shuts it again. Its own module because `#lsr-intent` stands outside
 * the diff root, so the diff's click handler — which answers every other fold
 * on the page — never sees a press on it.
 *
 * Delegated from the section rather than bound to the button: a round that
 * states a new reason rewrites everything inside the section, and a listener on
 * the button would go with the markup it was bound to. One listener, for the
 * life of the page.
 */
export function wireIntent(root: HTMLElement): void {
  root.addEventListener("click", (event) => {
    // The hint sits inside the button, so the target of a press on the words
    // "press to expand" is the span and not the press itself.
    const press =
      event.target instanceof Element ? event.target.closest(".lsr-intent-press") : null;
    if (!(press instanceof HTMLElement)) return;
    const body = root.querySelector<HTMLElement>(".lsr-intent-body");
    if (body === null) return;
    const open = press.getAttribute("aria-expanded") === "true";
    press.setAttribute("aria-expanded", String(!open));
    body.hidden = open;
  });
}
