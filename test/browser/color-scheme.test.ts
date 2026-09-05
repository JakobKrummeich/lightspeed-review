import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COLOR_SCHEME_OPTIONS,
  DARK_SCHEME_QUERY,
  DEFAULT_SCHEME,
  effectiveScheme,
  parseColorScheme,
  readColorScheme,
  writeColorScheme,
} from "../../src/browser/color-scheme.ts";

function fakeStorage(seed: Record<string, string> = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  };
}

test("a reviewer who never chose a scheme follows the operating system", () => {
  assert.equal(DEFAULT_SCHEME, "system");
  assert.equal(readColorScheme(fakeStorage()), "system");
});

test("the chosen scheme is remembered, and for every session at once", () => {
  const storage = fakeStorage();

  writeColorScheme(storage, "light");

  assert.equal(readColorScheme(storage), "light");
  // Eye comfort is a property of the reviewer, not of one review.
  assert.equal(readColorScheme(fakeStorage({ "lsr:color-scheme": "light" })), "light");
});

test("a stored value that is not a known scheme is ignored", () => {
  assert.equal(readColorScheme(fakeStorage({ "lsr:color-scheme": "sepia" })), "system");
});

test("storage the browser blocks is treated as no choice at all", () => {
  const blocked = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };

  assert.equal(readColorScheme(blocked), "system");
  assert.doesNotThrow(() => writeColorScheme(blocked, "dark"));
});

test("the system scheme resolves to whatever the operating system asks for", () => {
  assert.equal(effectiveScheme("system", true), "dark");
  assert.equal(effectiveScheme("system", false), "light");
});

test("an explicit choice wins over the operating system", () => {
  assert.equal(effectiveScheme("light", true), "light");
  assert.equal(effectiveScheme("dark", false), "dark");
});

test("the switch offers system first so following the OS stays one click away", () => {
  assert.deepEqual(
    COLOR_SCHEME_OPTIONS.map((option) => option.scheme),
    ["system", "light", "dark"],
  );
  assert.deepEqual(
    COLOR_SCHEME_OPTIONS.map((option) => option.label),
    ["Auto", "Light", "Dark"],
  );
});

test("a data-scheme attribute the DOM may have lost is narrowed", () => {
  assert.equal(parseColorScheme("dark"), "dark");
  assert.equal(parseColorScheme("sepia"), undefined);
  assert.equal(parseColorScheme(undefined), undefined);
});

test("the OS query asks for dark so a match means dark", () => {
  assert.equal(DARK_SCHEME_QUERY, "(prefers-color-scheme: dark)");
});
