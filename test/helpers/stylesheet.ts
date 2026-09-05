import { readFileSync } from "node:fs";

const ENTRY = new URL("../../src/browser/chrome.css", import.meta.url);
const CSS_DIR = new URL("../../src/browser/css/", import.meta.url);

/** One area stylesheet: the name the entry imports it by, and its text on disk. */
export interface StylesheetPart {
  name: string;
  text: string;
}

/**
 * The stylesheet the page is served, area by area, in cascade order — which is
 * import order, because esbuild inlines a relative `@import` where it stands.
 * An entry with no imports is still the whole stylesheet, so this reads the
 * same thing before and after the split.
 */
export function stylesheetParts(): StylesheetPart[] {
  const entry = readFileSync(ENTRY, "utf8");
  const names = [...entry.matchAll(/^@import "\.\/css\/([\w.-]+\.css)";$/gm)].map(
    ([, n]) => n ?? "",
  );
  if (names.length === 0) return [{ name: "chrome.css", text: entry }];
  return names.map((name) => ({ name, text: readFileSync(new URL(name, CSS_DIR), "utf8") }));
}

/**
 * Every rule the page is painted with, in the order the browser reads them.
 * Joined the way the blank line between two areas of one file used to read, so
 * a rule means the same thing to a regex whichever file it now lives in.
 */
export function stylesheet(): string {
  return stylesheetParts()
    .map((part) => part.text)
    .join("\n");
}
