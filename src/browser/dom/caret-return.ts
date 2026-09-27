/**
 * Where a room hands the caret back when it closes. The page can redraw under
 * the room — a round arriving replaces every thread reply box — so the element
 * that had the caret may be gone by then. Its twin is found by what names it:
 * its id, or else its tag, classes and data attributes (a reply box's
 * `data-thread`). An element with neither is not guessed at: any other button
 * would be a wrong place, and the caret stays where it falls.
 *
 * Taken when the room opens: the names are read then, not after a redraw.
 */
export function caretReturn(before: Element | null): (options?: FocusOptions) => void {
  if (!(before instanceof HTMLElement)) return () => undefined;
  const twin = twinOf(before);
  return (options) => {
    const home = before.isConnected ? before : twin?.();
    home?.focus(options);
  };
}

function twinOf(gone: HTMLElement): (() => HTMLElement | undefined) | undefined {
  const { id, className } = gone;
  const data = Object.entries(gone.dataset);
  if (id === "" && data.length === 0) return undefined;
  const same = (one: HTMLElement): boolean =>
    id !== ""
      ? one.id === id
      : one.className === className && data.every(([name, value]) => one.dataset[name] === value);
  return () => [...document.querySelectorAll<HTMLElement>(gone.tagName.toLowerCase())].find(same);
}
