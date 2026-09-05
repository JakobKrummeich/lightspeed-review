/** The slice of `localStorage` the scheme switch needs, so it can be faked in tests. */
export interface ColorSchemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** What the reviewer picked: an explicit scheme, or "follow the OS". */
export type ColorSchemePreference = "system" | "light" | "dark";

/** The scheme actually painted, once the OS has been asked. */
export type ColorScheme = "light" | "dark";

/** Matches while the operating system asks for dark. */
export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/** An undecided reviewer gets whatever the rest of their desktop is doing. */
export const DEFAULT_SCHEME: ColorSchemePreference = "system";

/**
 * All three choices, in switch order. "Auto" comes first so following the OS
 * stays reachable after an explicit pick, instead of being a one-way door.
 */
export const COLOR_SCHEME_OPTIONS: readonly {
  scheme: ColorSchemePreference;
  label: string;
}[] = [
  { scheme: "system", label: "Auto" },
  { scheme: "light", label: "Light" },
  { scheme: "dark", label: "Dark" },
];

/**
 * One key for every session: eye comfort belongs to the reviewer and their
 * room, not to the branch under review.
 */
const STORAGE_KEY = "lsr:color-scheme";

export function readColorScheme(storage: ColorSchemeStorage): ColorSchemePreference {
  // Storage access throws when the browser blocks it (private mode, no cookies).
  const stored = attempt(() => storage.getItem(STORAGE_KEY));
  return parseColorScheme(stored ?? undefined) ?? DEFAULT_SCHEME;
}

export function writeColorScheme(storage: ColorSchemeStorage, scheme: ColorSchemePreference): void {
  attempt(() => storage.setItem(STORAGE_KEY, scheme));
}

/** Narrows a `data-scheme` attribute, which is text the DOM may have lost. */
export function parseColorScheme(value: string | undefined): ColorSchemePreference | undefined {
  return COLOR_SCHEME_OPTIONS.find((option) => option.scheme === value)?.scheme;
}

export function effectiveScheme(
  preferred: ColorSchemePreference,
  prefersDark: boolean,
): ColorScheme {
  if (preferred !== "system") return preferred;
  return prefersDark ? "dark" : "light";
}

function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
