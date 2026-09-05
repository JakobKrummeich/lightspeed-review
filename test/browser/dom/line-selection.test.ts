import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionInLine } from "../../../src/browser/dom/line-selection.ts";
import { FakeElement, asElement, asRange, codeLine, type FakeNode } from "./fake-dom.ts";

/** A range that starts and ends inside the same line, as a drag over it does. */
const within = (node: FakeNode, start: number, end: number) =>
  asRange({ startContainer: node, startOffset: start, endContainer: node, endOffset: end });

test("a selection clipped inside one line quotes only the characters it covers", () => {
  const { line, texts } = codeLine("+", ["const user = fetchUser(id);"]);

  const selected = selectionInLine(asElement(line), within(texts[0]!, 13, 26));

  assert.equal(selected?.text, "fetchUser(id)");
  // 1-based and inclusive: character 14 through character 26.
  assert.deepEqual(selected?.columns, { start: 14, end: 26 });
});

test("a highlighted code span still clips: highlight.js appends its class", () => {
  const { line, content, texts } = codeLine("+", ["if (expiry <= now) {"]);
  // What syntax-highlight.ts does after painting: `line.classList.add("hljs")`.
  content.classes.push("hljs");

  const selected = selectionInLine(asElement(line), within(texts[0]!, 4, 10));

  assert.equal(selected?.text, "expiry");
  assert.deepEqual(selected?.columns, { start: 5, end: 10 });
});

test("a clipped line drops the diff marker: half a line is no diff line", () => {
  const { line, texts } = codeLine("-", ["throw new Error();"]);

  assert.equal(selectionInLine(asElement(line), within(texts[0]!, 0, 5))?.text, "throw");
});

test("a line covered end to end keeps its marker and carries no columns", () => {
  const { line, texts } = codeLine("+", ["const user = 1;"]);

  const selected = selectionInLine(asElement(line), within(texts[0]!, 0, 15));

  assert.equal(selected?.text, "+const user = 1;");
  assert.equal(selected?.columns, undefined);
});

test("columns are counted across the highlight spans the code is cut into", () => {
  const { line, texts } = codeLine("+", ["const ", "user", " = 1;"]);

  const selected = selectionInLine(
    asElement(line),
    asRange({
      startContainer: texts[1]!,
      startOffset: 0,
      endContainer: texts[2]!,
      endOffset: 3,
    }),
  );

  assert.equal(selected?.text, "user = ");
  assert.deepEqual(selected?.columns, { start: 7, end: 13 });
});

test("a line the selection only passes through is taken whole", () => {
  const first = codeLine("+", ["first();"]);
  const middle = codeLine("+", ["middle();"]);
  const last = codeLine("+", ["last();"]);
  const range = asRange({
    startContainer: first.texts[0]!,
    startOffset: 5,
    endContainer: last.texts[0]!,
    endOffset: 4,
  });

  const selected = [first, middle, last].map((entry) =>
    selectionInLine(asElement(entry.line), range),
  );

  assert.deepEqual(
    selected.map((line) => [line?.text, line?.columns]),
    [
      ["();", { start: 6, end: 8 }],
      ["+middle();", undefined],
      ["last", { start: 1, end: 4 }],
    ],
  );
});

test("columns count UTF-16 code units, which is what the DOM offsets are", () => {
  const { line, texts } = codeLine("+", ["const badge = '\u{1f680}';"]);

  // The rocket is one character but two code units, so it spans two columns.
  const selected = selectionInLine(asElement(line), within(texts[0]!, 15, 17));

  assert.equal(selected?.text, "\u{1f680}");
  assert.deepEqual(selected?.columns, { start: 16, end: 17 });
});

test("a boundary in an element counts the children before it, not characters", () => {
  const { line, content } = codeLine("+", ["const ", "user", " = 1;"]);

  const selected = selectionInLine(
    asElement(line),
    asRange({ startContainer: content, startOffset: 1, endContainer: content, endOffset: 2 }),
  );

  assert.equal(selected?.text, "user");
  assert.deepEqual(selected?.columns, { start: 7, end: 10 });
});

test("a line the range only touches yields nothing rather than an empty quote", () => {
  const { line, texts } = codeLine("+", ["const user = 1;"]);

  // A selection of the previous line ends where this one starts.
  assert.equal(selectionInLine(asElement(line), within(texts[0]!, 0, 0)), undefined);
});

test("a zero-width range reported on the row cell marks nothing of the line", () => {
  const { line } = codeLine("+", ["const user = 1;"]);

  // Dragging down, browsers report the boundary as cell + child index; before the code span
  // both ends sit outside the code, so none of it is selected.
  assert.equal(selectionInLine(asElement(line), within(line, 0, 0)), undefined);
});

test("a range that runs over the row cell's children takes the line whole", () => {
  const { line } = codeLine("+", ["const user = 1;"]);

  // Child 0 is the template's indentation, 1 the marker, 2 the code: an end
  // past the code span covers every character of it.
  const selected = selectionInLine(asElement(line), within(line, 0, 3));

  assert.equal(selected?.text, "+const user = 1;");
  assert.equal(selected?.columns, undefined);
});

test("a range that starts past the code marks nothing of the line", () => {
  const { line } = codeLine("+", ["const user = 1;"]);

  // Mirror case: begins after the code, on a line the selection already left — contributes
  // nothing rather than a slice counted from "past the end".
  assert.equal(selectionInLine(asElement(line), within(line, 3, 3)), undefined);
});

test("an end on the row cell before the code leaves the line out, whole line and all", () => {
  const previous = codeLine("+", ["first();"]);
  const { line } = codeLine("+", ["const user = 1;"]);

  // An end *at* child 2 (the code span) stops in front of it: none of this line's characters marked.
  const range = asRange({
    startContainer: previous.texts[0]!,
    startOffset: 0,
    endContainer: line,
    endOffset: 2,
  });

  assert.equal(selectionInLine(asElement(line), range), undefined);
});

test("an end on the row, an ancestor further up, is placed by the child holding the code", () => {
  const previous = codeLine("+", ["first();"]);
  const { line } = codeLine("+", ["const user = 1;"]);
  const row = new FakeElement("tr", []).append(
    new FakeElement("td", ["d2h-code-linenumber"], "12"),
    line,
  );

  // Browsers report a drag ending between rows on the row itself; an end at child 1 (the code
  // cell) is still in front of the code however deep below the row it sits.
  const range = asRange({
    startContainer: previous.texts[0]!,
    startOffset: 0,
    endContainer: row,
    endOffset: 1,
  });

  assert.equal(selectionInLine(asElement(line), range), undefined);
});

test("an end past the row's code cell covers the line to its last character", () => {
  const previous = codeLine("+", ["first();"]);
  const { line } = codeLine("+", ["const user = 1;"]);
  const row = new FakeElement("tr", []).append(
    new FakeElement("td", ["d2h-code-linenumber"], "12"),
    line,
  );

  const range = asRange({
    startContainer: previous.texts[0]!,
    startOffset: 0,
    endContainer: row,
    endOffset: 2,
  });

  const selected = selectionInLine(asElement(line), range);

  assert.equal(selected?.text, "+const user = 1;");
  assert.equal(selected?.columns, undefined);
});

test("selecting the marker alone takes the whole line: the marker is not code", () => {
  const { line } = codeLine("+", ["const user = 1;"]);
  const marker = line.querySelector(".d2h-code-line-prefix")!.childNodes[0]!;

  const selected = selectionInLine(asElement(line), within(marker, 0, 1));

  assert.equal(selected?.text, "+const user = 1;");
  assert.equal(selected?.columns, undefined);
});

test("an empty line is still taken whole, so its marker survives", () => {
  const { line, content } = codeLine("+", []);

  const selected = selectionInLine(
    asElement(line),
    asRange({ startContainer: content, startOffset: 0, endContainer: content, endOffset: 0 }),
  );

  assert.equal(selected?.text, "+");
  assert.equal(selected?.columns, undefined);
});

test("a line without a code span is taken whole and squeezed back into one line", () => {
  const line = new FakeElement("td", ["d2h-code-line"], "\n      +const user = 1;\n    ");

  const selected = selectionInLine(asElement(line), within(line, 0, 1));

  assert.equal(selected?.text, "+const user = 1;");
  assert.equal(selected?.columns, undefined);
});
