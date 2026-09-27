/**
 * A full-screen room (the opening, the round jump) makes the page behind it
 * inert while it is up: Tab, a click that slips through and a screen reader's
 * cursor all stay out of a review nobody can see. `aria-modal` alone asks
 * nothing of the keyboard.
 *
 * Only what this hold made inert is handed back, so a sibling something else
 * set inert stays inert, and two holds in a row do not undo each other.
 */
export function holdPageBehind(room: HTMLElement): () => void {
  const held: HTMLElement[] = [];
  for (const element of Array.from(document.body?.children ?? [])) {
    if (element === room || !(element instanceof HTMLElement) || element.inert) continue;
    element.inert = true;
    held.push(element);
  }
  return () => {
    for (const element of held.splice(0)) element.inert = false;
  };
}
