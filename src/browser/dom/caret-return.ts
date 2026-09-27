/**
 * Where a room hands the caret back when it closes. The page can redraw under
 * the room — a round arriving replaces every thread reply box — so the element
 * that had the caret may be gone by then. Its twin is found by what names it:
 * its id, or else its tag, classes and the data attributes that say which
 * thing it is (`NAMES`: a reply box's `data-thread`). Attributes that say where
 * a thing sits or how it looks (`data-index`, `data-group-index`, `data-form`,
 * `data-state`) name nothing: after a redraw the same place can hold another
 * thing. An element with no name is not guessed at: any other control would
 * be a wrong place, and the caret stays where it falls.
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

/**
 * The data attributes that name a thing in this page's markup: a thread (its
 * reply box and buttons), a card and its fold, a file (with the line a prompt
 * points at in it).
 */
const NAMES = ["thread", "key", "fold", "file", "side", "line"] as const;

function twinOf(gone: HTMLElement): (() => HTMLElement | undefined) | undefined {
  const { id, className } = gone;
  const names = NAMES.flatMap((name) => {
    const value = gone.dataset[name];
    return value === undefined ? [] : [[name, value] as const];
  });
  if (id === "" && names.length === 0) return undefined;
  const same = (one: HTMLElement): boolean =>
    id !== ""
      ? one.id === id
      : one.className === className && names.every(([name, value]) => one.dataset[name] === value);
  return () => [...document.querySelectorAll<HTMLElement>(gone.tagName.toLowerCase())].find(same);
}
