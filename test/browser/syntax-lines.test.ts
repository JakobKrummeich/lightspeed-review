import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightSide, splitHighlightedLines } from "../../src/browser/syntax-lines.ts";
import { loadHighlighter } from "../../src/browser/syntax-grammars.ts";

test("plain output splits into one entry per line", () => {
  assert.deepEqual(splitHighlightedLines("a\nb\nc"), ["a", "b", "c"]);
  assert.deepEqual(splitHighlightedLines(""), [""]);
});

test("a span that crosses a line break is closed and reopened around it", () => {
  const split = splitHighlightedLines('<span class="hljs-comment">/* two\nlines */</span>');

  assert.deepEqual(split, [
    '<span class="hljs-comment">/* two</span>',
    '<span class="hljs-comment">lines */</span>',
  ]);
});

test("nested spans are reopened in the order they were opened", () => {
  const split = splitHighlightedLines(
    '<span class="a">one<span class="b">two\nthree</span></span>four',
  );

  assert.deepEqual(split, [
    '<span class="a">one<span class="b">two</span></span>',
    '<span class="a"><span class="b">three</span></span>four',
  ]);
});

test("escaped markup in the highlighted code survives the split", () => {
  assert.deepEqual(splitHighlightedLines('<span class="hljs-tag">&lt;td&gt;</span>\nx'), [
    '<span class="hljs-tag">&lt;td&gt;</span>',
    "x",
  ]);
});

test("a whole side is highlighted as one document, so multi-line syntax works", async () => {
  const hljs = await loadHighlighter(["typescript"]);
  assert.ok(hljs);
  const lines = ["  return (", "    <tr key={event.id}>", "      <td>{event.kind}</td>", "  );"];

  const painted = highlightSide(hljs, "typescript", lines);

  assert.ok(painted, "expected the side to be highlighted");
  assert.equal(painted.length, lines.length);
  // Line by line, `<tr ...>` is unparseable JSX; in the context of the return
  // statement above it, highlight.js hands the tags to its xml grammar.
  assert.match(painted[1]!, /hljs-name">tr</);
  assert.match(painted[2]!, /hljs-name">td</);
});

test("a side highlight that loses lines is refused rather than misaligned", async () => {
  const hljs = await loadHighlighter(["typescript"]);
  assert.ok(hljs);
  // Text carrying its own newlines would make one entry cover several lines and
  // shift every following line's colours onto the wrong code.
  assert.equal(highlightSide(hljs, "typescript", ["const a = 1;\nconst b = 2;"]), undefined);
});
