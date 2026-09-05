import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LANGUAGE_BY_EXTENSION,
  LANGUAGE_BY_FILENAME,
  languageForPath,
} from "../../src/browser/syntax-languages.ts";

test("picks a grammar from the file extension", () => {
  assert.equal(languageForPath("src/browser/dom/main.ts"), "typescript");
  assert.equal(languageForPath("scripts/build.mjs"), "javascript");
  assert.equal(languageForPath("package.json"), "json");
});

test("matches the extension whatever its case", () => {
  assert.equal(languageForPath("docs/README.MD"), "markdown");
});

test("names some files carry instead of an extension", () => {
  assert.equal(languageForPath("build/Dockerfile"), "dockerfile");
  assert.equal(languageForPath("Makefile"), "makefile");
});

test("an unknown or extensionless file gets no grammar rather than a guess", () => {
  assert.equal(languageForPath("assets/logo.svgz"), undefined);
  assert.equal(languageForPath("LICENSE"), undefined);
  assert.equal(languageForPath(""), undefined);
  // A dotfile is all name and no extension: highlighting it as "gitignore"
  // would need a grammar that does not exist.
  assert.equal(languageForPath(".gitignore"), undefined);
});

test("every mapped language is spelled the way highlight.js spells it", () => {
  const names = [...Object.values(LANGUAGE_BY_EXTENSION), ...Object.values(LANGUAGE_BY_FILENAME)];

  for (const name of names) {
    assert.match(name, /^[a-z0-9]+$/, `${name} is not a highlight.js grammar id`);
  }
});
