import {
  effectiveScheme,
  parseColorScheme,
  readColorScheme,
  writeColorScheme,
  type ColorSchemeStorage,
} from "../color-scheme.ts";

export interface SchemeToggleOptions {
  /** The segmented control; its `button[data-scheme]` children are the options. */
  root: HTMLElement;
  /** Carries the painted scheme for the stylesheet, normally `<html>`. */
  target: HTMLElement;
  storage: ColorSchemeStorage;
  /** Matches while the operating system asks for dark. */
  prefersDark: MediaQueryList;
}

/**
 * Wires the header colour-scheme switch. The stylesheet resolves every colour
 * with `light-dark()`, so painting a scheme is a single `color-scheme` value:
 * this sets `data-color-scheme` on `<html>` and the CSS does the rest.
 */
export function mountSchemeToggle(options: SchemeToggleOptions): void {
  const buttons = [...options.root.querySelectorAll<HTMLButtonElement>("button[data-scheme]")];
  let preferred = readColorScheme(options.storage);
  apply();

  for (const button of buttons) {
    button.addEventListener("click", () => {
      const picked = parseColorScheme(button.dataset.scheme);
      if (!picked) return;
      preferred = picked;
      writeColorScheme(options.storage, preferred);
      apply();
    });
  }

  // On "Auto" the OS can change under the page (sunset, system setting).
  options.prefersDark.addEventListener("change", apply);

  function apply(): void {
    options.target.dataset.colorScheme = effectiveScheme(preferred, options.prefersDark.matches);
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.scheme === preferred));
    }
  }
}
