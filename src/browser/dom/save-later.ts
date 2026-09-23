/**
 * Debounce for keystroke/scroll bursts. Long enough that a held key is one
 * write, not fifty (`localStorage` is synchronous and carries every queued
 * pill); short enough to finish before a reader stops to think.
 */
export const SAVE_DELAY_MS = 250;

export interface LaterSave {
  soon(): void;
  now(): void;
}

/** Content read at run time, not ask time: the last ask of a burst decides. */
export function saveLater(write: () => void, delay = SAVE_DELAY_MS): LaterSave {
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    waiting = undefined;
    write();
  };
  return {
    soon() {
      clearTimeout(waiting);
      waiting = setTimeout(run, delay);
    },
    now() {
      // Only if asked for: pagehide itself is not news, and storing on it
      // would rewrite untouched records.
      if (waiting === undefined) return;
      clearTimeout(waiting);
      run();
    },
  };
}
