import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTEXT_RADIUS, sliceContext } from "../../src/ledger/context.ts";

/** `line 1` … `line 200`, so a slice can be read back as the lines it covers. */
const file = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");

function lines(context: string | undefined): string[] {
  return (context ?? "").split("\n");
}

test("an anchored selection is sliced from the file around its own lines", () => {
  const sliced = sliceContext(file, {
    selected_text: "line 100",
    side: "new",
    line_start: 100,
    line_end: 102,
  });

  assert.equal(sliced.context_source, "anchor");
  assert.equal(lines(sliced.context)[0], `line ${100 - CONTEXT_RADIUS}`);
  assert.equal(lines(sliced.context).at(-1), `line ${102 + CONTEXT_RADIUS}`);
});

test("an anchor at the top of the file slices from line 1 rather than padding", () => {
  const sliced = sliceContext(file, {
    selected_text: "line 2",
    side: "new",
    line_start: 2,
    line_end: 2,
  });

  assert.equal(lines(sliced.context)[0], "line 1");
  assert.equal(lines(sliced.context).length, 1 + 1 + CONTEXT_RADIUS);
});

test("an anchor past the end of the file is clamped to the lines that exist", () => {
  const sliced = sliceContext(file, {
    selected_text: "line 200",
    side: "new",
    line_start: 500,
    line_end: 900,
  });

  assert.equal(sliced.context_source, "anchor");
  assert.equal(lines(sliced.context).at(-1), "line 200");
  assert.equal(lines(sliced.context).length, CONTEXT_RADIUS + 1);
});

test("an inverted anchor still slices around its start", () => {
  const sliced = sliceContext(file, {
    selected_text: "line 40",
    side: "old",
    line_start: 40,
    line_end: 3,
  });

  assert.equal(sliced.context_source, "anchor");
  assert.equal(lines(sliced.context)[0], `line ${40 - CONTEXT_RADIUS}`);
  assert.equal(lines(sliced.context).at(-1), `line ${40 + CONTEXT_RADIUS}`);
});

test("without an anchor the selected text is located in the file", () => {
  const sliced = sliceContext(file, { selected_text: "line 150" });

  assert.equal(sliced.context_source, "search");
  assert.equal(lines(sliced.context)[0], `line ${150 - CONTEXT_RADIUS}`);
  assert.equal(lines(sliced.context).at(-1), `line ${150 + CONTEXT_RADIUS}`);
});

test("a multi-line selection is located by its first line and covers its last", () => {
  const sliced = sliceContext(file, { selected_text: "line 100\nline 101\nline 102" });

  assert.equal(sliced.context_source, "search");
  assert.equal(lines(sliced.context).at(-1), `line ${102 + CONTEXT_RADIUS}`);
});

test("a selection the browser trimmed still matches the indented source line", () => {
  const sliced = sliceContext("a\n    needle();\nb", { selected_text: "needle();" });

  assert.equal(sliced.context_source, "search");
  assert.equal(sliced.context, "a\n    needle();\nb");
});

test("text that is nowhere in the file yields no context", () => {
  const sliced = sliceContext(file, { selected_text: "not in this file" });

  assert.deepEqual(sliced, { context_source: "none" });
});

test("a whitespace-only selection is not searched for", () => {
  const sliced = sliceContext(file, { selected_text: "   \n  " });

  assert.deepEqual(sliced, { context_source: "none" });
});

test("a file git could not produce — binary, oversized, deleted — yields no context", () => {
  assert.deepEqual(sliceContext(undefined, { selected_text: "line 10" }), {
    context_source: "none",
  });
  assert.deepEqual(
    sliceContext(undefined, { selected_text: "x", side: "new", line_start: 1, line_end: 2 }),
    {
      context_source: "none",
    },
  );
  assert.deepEqual(sliceContext("", { selected_text: "line 10" }), { context_source: "none" });
});
