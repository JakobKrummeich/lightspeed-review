/**
 * Makes the page behind a full-screen room inert: `aria-modal` alone asks
 * nothing of the keyboard. Only what this hold made inert is handed back, so
 * something else's inert sibling stays inert.
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
