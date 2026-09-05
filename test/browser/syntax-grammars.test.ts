import { test } from "node:test";
import assert from "node:assert/strict";
import { GRAMMAR_LOADERS, loadHighlighter } from "../../src/browser/syntax-grammars.ts";
import { LANGUAGE_BY_EXTENSION, LANGUAGE_BY_FILENAME } from "../../src/browser/syntax-languages.ts";

test("every language a file can map to has a grammar to load", () => {
  const mapped = new Set([
    ...Object.values(LANGUAGE_BY_EXTENSION),
    ...Object.values(LANGUAGE_BY_FILENAME),
  ]);

  const missing = [...mapped].filter((language) => !(language in GRAMMAR_LOADERS));

  assert.deepEqual(missing, [], `no grammar loader for: ${missing.join(", ")}`);
});

test("loads the grammars it is asked for and highlights with them", async () => {
  const hljs = await loadHighlighter(["typescript"]);

  assert.ok(hljs, "expected a highlighter for a known language");
  const { value } = hljs.highlight("const answer = 42;", {
    language: "typescript",
    ignoreIllegals: true,
  });
  assert.match(value, /hljs-keyword">const</);
});

test("a grammar that delegates gets the grammar it delegates to", async () => {
  const hljs = await loadHighlighter(["typescript"]);

  assert.ok(hljs);
  // JSX inside a .tsx file is handed to the `xml` grammar by highlight.js
  // itself; unregistered, the tags come out as plain text.
  assert.ok(hljs.getLanguage("xml"), "xml is not registered alongside typescript");
  const { value } = hljs.highlight('const view = <Row kind="click" />;', {
    language: "typescript",
    ignoreIllegals: true,
  });
  assert.match(value, /hljs-tag/);
  assert.match(value, /hljs-name">Row</);
});

test("loading the same grammar twice registers it once", async () => {
  const first = await loadHighlighter(["json"]);
  const second = await loadHighlighter(["json"]);

  assert.equal(first, second);
  assert.ok(second?.getLanguage("json"));
});

test("unknown languages load nothing at all", async () => {
  // Nothing to highlight means no reason to pull highlight.js over the wire.
  assert.equal(await loadHighlighter(["klingon"]), undefined);
  assert.equal(await loadHighlighter([]), undefined);
});
