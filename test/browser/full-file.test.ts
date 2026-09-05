import { test } from "node:test";
import assert from "node:assert/strict";
import { renderFullFile } from "../../src/browser/full-file.ts";
import type { FileHighlight } from "../../src/browser/syntax-file.ts";

/** A highlight as `highlightFile` hands it over: one HTML and one text entry per line. */
function highlight(contents: string, html: string[]): FileHighlight {
  return { html, text: contents.split("\n") };
}

test("every line is numbered once, in the new side's own gutter column", () => {
  const html = renderFullFile("const a = 1;\nconst b = 2;", undefined);

  assert.match(html, /<div class="line-num2">1<\/div>/);
  assert.match(html, /<div class="line-num2">2<\/div>/);
  // The old side's column stays empty: the whole file has no old numbers to show.
  assert.doesNotMatch(html, /<div class="line-num1">\d/);
  assert.equal(html.match(/<tr>/g)?.length, 2);
});

test("the rows wear diff2html's own classes, so a diff's styling covers them", () => {
  const html = renderFullFile("one line", undefined);

  assert.match(html, /<table class="d2h-diff-table">/);
  assert.match(html, /<td class="d2h-code-linenumber d2h-cntx">/);
  assert.match(html, /<div class="d2h-code-line">/);
  assert.match(html, /<span class="d2h-code-line-ctn">one line<\/span>/);
});

test("a trailing newline is a terminator, not one more empty line to number", () => {
  const html = renderFullFile("const a = 1;\n", undefined);

  assert.equal(html.match(/<tr>/g)?.length, 1);
});

test("highlighted lines are injected as handed over, under the hljs class", () => {
  const contents = "const a = 1;\nconst b = 2;";
  const painted = highlight(contents, [
    '<span class="hljs-keyword">const</span> a = 1;',
    '<span class="hljs-keyword">const</span> b = 2;',
  ]);

  const html = renderFullFile(contents, painted);

  assert.match(
    html,
    /<span class="d2h-code-line-ctn hljs"><span class="hljs-keyword">const<\/span> a = 1;<\/span>/,
  );
});

test("a file with no highlight is escaped, never trusted as markup", () => {
  const html = renderFullFile('<script>alert("x")</script>', undefined);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
});

test("a highlight of the wrong length is dropped rather than shifted onto other lines", () => {
  const contents = "line one\nline two";
  const misaligned = { html: ["<span>line one</span>"], text: ["line one"] };

  const html = renderFullFile(contents, misaligned);

  assert.doesNotMatch(html, /hljs/);
  assert.match(html, /<span class="d2h-code-line-ctn">line two<\/span>/);
});

test("the view says it is read-only, naming the press that takes feedback", () => {
  const html = renderFullFile("one line", undefined);

  assert.match(html, /<p class="lsr-approved-note">/);
  assert.match(html, /Read-only view/);
  assert.match(html, /press Branch diff/);
});

test("an empty file says so instead of drawing a table with nothing in it", () => {
  const html = renderFullFile("", undefined);

  assert.doesNotMatch(html, /d2h-diff-table/);
  // Nothing to select, so nothing to say about feedback either.
  assert.doesNotMatch(html, /lsr-approved-note/);
  assert.match(html, /<p class="lsr-approved-missing">This file is empty\.<\/p>/);
});
