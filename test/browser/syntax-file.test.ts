import { test } from "node:test";
import assert from "node:assert/strict";
import { highlightFile, htmlForRow, type FileHighlight } from "../../src/browser/syntax-file.ts";
import { loadHighlighter } from "../../src/browser/syntax-grammars.ts";

const JSX_FILE = [
  "export function Row({ event }) {",
  "  return (",
  "    <tr key={event.id}>",
  "      <td>{event.kind}</td>",
  "    </tr>",
  "  );",
  "}",
  "",
].join("\n");

async function highlighted(contents: string): Promise<FileHighlight> {
  const hljs = await loadHighlighter(["javascript"]);
  assert.ok(hljs);
  const file = highlightFile(hljs, "javascript", contents);
  assert.ok(file, "expected the file to be highlighted");
  return file;
}

test("a whole file is highlighted with one entry per line", async () => {
  const file = await highlighted(JSX_FILE);

  assert.equal(file.html.length, JSX_FILE.split("\n").length);
  assert.deepEqual(file.text, JSX_FILE.split("\n"));
});

test("markup only the surrounding file explains is still highlighted", async () => {
  const file = await highlighted(JSX_FILE);

  // A hunk holding only this line reads as a comparison, not as JSX.
  assert.match(file.html[3]!, /hljs-name">td</);
});

test("a row is painted from the file line it says it shows", async () => {
  const file = await highlighted(JSX_FILE);

  assert.equal(htmlForRow(file, { number: 4, text: "      <td>{event.kind}</td>" }), file.html[3]);
});

test("a row diff2html padded with non-breaking spaces still matches its file line", async () => {
  const file = await highlighted(JSX_FILE);

  const row = { number: 4, text: "\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0<td>{event.kind}</td>" };

  assert.equal(htmlForRow(file, row), file.html[3]);
});

test("a row the file cannot account for is left to the caller", async () => {
  const file = await highlighted(JSX_FILE);

  // The other version's rows carry no number for this side.
  assert.equal(htmlForRow(file, { number: undefined, text: "  return (" }), undefined);
  // Past the end, or different text: the file on screen is not the file we read.
  assert.equal(htmlForRow(file, { number: 99, text: "  return (" }), undefined);
  assert.equal(htmlForRow(file, { number: 2, text: "  return null;" }), undefined);
});
