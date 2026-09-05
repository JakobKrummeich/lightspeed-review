import type { DiffOutputFormat } from "./diff2html-adapter.ts";

/** The slice of `localStorage` the view toggle needs, so it can be faked in tests. */
export interface ViewFormatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Two code columns plus the 22rem conversation panel stop being readable below
 * this width, so side-by-side falls back to unified there.
 */
const COLUMNS_MIN_PX = 1400;
export const WIDE_VIEWPORT_QUERY = `(min-width: ${COLUMNS_MIN_PX}px)`;

/** The conversation panel's column, which a collapsed panel gives back. */
export const PANEL_WIDTH_PX = 352;

/**
 * The breakpoint has to count the panel, not assume it: with the panel shut,
 * the two columns have its width back and side-by-side fits 352px earlier.
 */
export function roomQuery(panelCollapsed: boolean): string {
  return panelCollapsed ? `(min-width: ${COLUMNS_MIN_PX - PANEL_WIDTH_PX}px)` : WIDE_VIEWPORT_QUERY;
}

/** Unified fits every viewport, so it is what an undecided reviewer gets. */
export const DEFAULT_FORMAT: DiffOutputFormat = "line-by-line";

/** The view the reviewer picked, which may be wider than the viewport allows. */
export function readViewFormat(storage: ViewFormatStorage, sessionKey: string): DiffOutputFormat {
  // Storage access throws when the browser blocks it (private mode, no cookies).
  const stored = attempt(() => storage.getItem(storageKey(sessionKey)));
  return stored === "side-by-side" ? stored : DEFAULT_FORMAT;
}

export function writeViewFormat(
  storage: ViewFormatStorage,
  sessionKey: string,
  format: DiffOutputFormat,
): void {
  attempt(() => storage.setItem(storageKey(sessionKey), format));
}

/** The view that is actually rendered: side-by-side only where it fits. */
export function effectiveFormat(
  preferred: DiffOutputFormat,
  wideViewport: boolean,
): DiffOutputFormat {
  return preferred === "side-by-side" && !wideViewport ? DEFAULT_FORMAT : preferred;
}

/**
 * Both views, in switch order. Each option names the view it shows, so the
 * control says what the reviewer is looking at instead of where a click leads.
 */
export const VIEW_FORMAT_OPTIONS: readonly { format: DiffOutputFormat; label: string }[] = [
  { format: "line-by-line", label: "Unified" },
  { format: "side-by-side", label: "Side-by-side" },
];

/** Narrows a `data-format` attribute, which is text the DOM may have lost. */
export function parseViewFormat(value: string | undefined): DiffOutputFormat | undefined {
  return VIEW_FORMAT_OPTIONS.find((option) => option.format === value)?.format;
}

function storageKey(sessionKey: string): string {
  return `lsr:view-format:${sessionKey}`;
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
