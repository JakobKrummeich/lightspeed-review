import { test } from "node:test";
import assert from "node:assert/strict";
import { findLine, lineNumbers, sideColumns } from "../../../src/browser/dom/line-numbers.ts";
import { FakeElement, asElement, sideBySideFile, unifiedRow } from "./fake-dom.ts";

test("a unified row carries both numbers of a context line", () => {
  const { line } = unifiedRow({ old: 40, new: 12 });

  assert.deepEqual(lineNumbers(asElement(line), []), { old: 40, new: 12 });
});

test("an empty unified gutter cell means the line is missing from that version", () => {
  const added = unifiedRow({ new: 12 });
  const removed = unifiedRow({ old: 40 });

  assert.deepEqual(lineNumbers(asElement(added.line), []), { old: undefined, new: 12 });
  assert.deepEqual(lineNumbers(asElement(removed.line), []), { old: 40, new: undefined });
});

test("a side-by-side line takes its version from the column it sits in", () => {
  const { file, oldLine, newLine } = sideBySideFile({ old: 40, new: 12 });
  const columns = sideColumns(asElement(file));

  assert.deepEqual(lineNumbers(asElement(oldLine), columns), { old: 40 });
  assert.deepEqual(lineNumbers(asElement(newLine), columns), { new: 12 });
});

test("a side-by-side placeholder without a number yields no number", () => {
  const { file, newLine } = sideBySideFile({ old: 40 });
  const columns = sideColumns(asElement(file));

  assert.deepEqual(lineNumbers(asElement(newLine), columns), { new: undefined });
});

test("a side-by-side line in neither column stays unnumbered rather than read the unified gutter", () => {
  const { file } = sideBySideFile({ old: 40, new: 12 });
  const stray = unifiedRow({ old: 7, new: 8 });

  assert.deepEqual(lineNumbers(asElement(stray.line), sideColumns(asElement(file))), {});
});

test("a line outside any row has no numbers to read", () => {
  const orphan = new FakeElement("td", ["d2h-code-line"], "+x");

  assert.deepEqual(lineNumbers(asElement(orphan), []), {});
});

test("a unified file has no columns", () => {
  const { row } = unifiedRow({ new: 12 });

  assert.deepEqual(sideColumns(asElement(row)), []);
});

test("a place is found among unified rows by side and number", () => {
  const first = unifiedRow({ old: 40, new: 12 });
  const second = unifiedRow({ new: 13 });
  const file = new FakeElement("div", ["lsr-file"]).append(first.row, second.row);

  assert.equal(findLine(asElement(file), { side: "new", line: 13 }), second.line);
  assert.equal(findLine(asElement(file), { side: "old", line: 40 }), first.line);
});

test("a place the diff no longer prints is honestly not found", () => {
  const { row } = unifiedRow({ new: 12 });
  const file = new FakeElement("div", ["lsr-file"]).append(row);

  assert.equal(findLine(asElement(file), { side: "new", line: 99 }), undefined);
  assert.equal(findLine(asElement(file), { side: "old", line: 12 }), undefined);
});

test("a side-by-side place is read from its own column", () => {
  const sbs = sideBySideFile({ old: 40, new: 12 });

  assert.equal(findLine(asElement(sbs.file), { side: "old", line: 40 }), sbs.oldLine);
  assert.equal(findLine(asElement(sbs.file), { side: "new", line: 12 }), sbs.newLine);
});
