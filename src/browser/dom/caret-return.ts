/**
 * Where a room hands the caret back when it closes. The page can redraw under
 * the room, so the element that had the caret may be gone: its twin is found
 * by id, or by tag, classes and the data attributes that name it (`NAMES`).
 * Attributes of place or look (`data-index`, `data-state`, …) are ignored — after
 * a redraw the same place can hold another thing — and an element with no
 * name is not guessed at. Call it when the room opens, before any redraw.
 */
export function caretReturn(before: Element | null): (options?: FocusOptions) => void {
  if (!(before instanceof HTMLElement)) return () => undefined;
  const twin = twinOf(before);
  return (options) => {
    const home = before.isConnected ? before : twin?.();
    home?.focus(options);
  };
}

/** The data attributes that name a thread, a card and its fold, a file and a line. */
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
