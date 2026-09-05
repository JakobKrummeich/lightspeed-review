import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationsFrom,
  anchorFor,
  renderAnnotationPopup,
  selectionPreview,
  type SelectionFragment,
} from "../../src/browser/annotation.ts";

const fragment = (file: string, text: string, group = "API"): SelectionFragment => ({
  file,
  group,
  text,
});

test("turns a single-file selection into one annotation carrying file and group", () => {
  const prompts = annotationsFrom([fragment("src/api/users.ts", "+const user = 1;")], "wrap this");

  assert.deepEqual(prompts, [
    {
      type: "annotation",
      file: "src/api/users.ts",
      group: "API",
      selected_text: "+const user = 1;",
      comment: "wrap this",
    },
  ]);
});

test("splits a selection spanning two files into one annotation per file", () => {
  const prompts = annotationsFrom(
    [fragment("a.ts", "+first"), fragment("b.ts", "-second", "Cleanup")],
    "why?",
  );

  assert.deepEqual(
    prompts.map((prompt) => [prompt.file, prompt.group, prompt.selected_text]),
    [
      ["a.ts", "API", "+first"],
      ["b.ts", "Cleanup", "-second"],
    ],
  );
});

test("joins several fragments from the same file into one annotation", () => {
  const prompts = annotationsFrom(
    [fragment("a.ts", "+first"), fragment("a.ts", "+second")],
    "why?",
  );

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.selected_text, "+first\n+second");
});

test("ignores fragments that hold no selected text", () => {
  const prompts = annotationsFrom([fragment("a.ts", ""), fragment("b.ts", "+kept")], "why?");

  assert.deepEqual(
    prompts.map((prompt) => prompt.file),
    ["b.ts"],
  );
});

test("a selection of nothing but whitespace is still an annotation", () => {
  // Clipped to the trailing spaces of a line, which is exactly the kind of
  // thing a reviewer selects on purpose — and queueing it must not fail mute.
  const prompts = annotationsFrom(
    [
      {
        ...fragment("a.ts", "   "),
        anchor: { side: "new", line_start: 12, line_end: 12, col_start: 28, col_end: 30 },
      },
    ],
    "trailing whitespace",
  );

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.selected_text, "   ");
});

test("a blank comment queues nothing: an annotation without a question is noise", () => {
  assert.deepEqual(annotationsFrom([fragment("a.ts", "+first")], "   "), []);
});

test("trims surrounding whitespace from the comment but keeps diff prefixes intact", () => {
  const prompts = annotationsFrom([fragment("a.ts", "-  old();\n+  fresh();")], "  swap back  ");

  assert.equal(prompts[0]!.comment, "swap back");
  assert.equal(prompts[0]!.selected_text, "-  old();\n+  fresh();");
});

test("an anchor spans the new-side numbers of the selected lines", () => {
  assert.deepEqual(anchorFor([{ new: 12 }, { old: 40, new: 13 }, { new: 14 }]), {
    side: "new",
    line_start: 12,
    line_end: 14,
  });
});

test("a selection of removed lines only is anchored on the old side", () => {
  assert.deepEqual(anchorFor([{ old: 40 }, { old: 41 }]), {
    side: "old",
    line_start: 40,
    line_end: 41,
  });
});

test("a selection mixing removed and added lines anchors on the new side", () => {
  assert.deepEqual(anchorFor([{ old: 40 }, { new: 41 }, { new: 42 }]), {
    side: "new",
    line_start: 41,
    line_end: 42,
  });
});

test("a clipped line anchors to the characters it was clipped to", () => {
  assert.deepEqual(anchorFor([{ new: 12, columns: { start: 14, end: 26 } }]), {
    side: "new",
    line_start: 12,
    line_end: 12,
    col_start: 14,
    col_end: 26,
  });
});

test("a multi-line selection takes its columns from the two lines it clips", () => {
  assert.deepEqual(
    anchorFor([
      { new: 12, columns: { start: 6, end: 18 } },
      { new: 13 },
      { new: 14, columns: { start: 1, end: 4 } },
    ]),
    { side: "new", line_start: 12, line_end: 14, col_start: 6, col_end: 4 },
  );
});

test("a boundary line taken whole carries no column, which is what says 'whole line'", () => {
  assert.deepEqual(anchorFor([{ new: 12 }, { new: 13, columns: { start: 1, end: 4 } }]), {
    side: "new",
    line_start: 12,
    line_end: 13,
    col_end: 4,
  });
});

test("columns of lines on the unselected side are ignored with the lines themselves", () => {
  assert.deepEqual(
    anchorFor([
      { old: 40, columns: { start: 3, end: 9 } },
      { new: 12, columns: { start: 6, end: 18 } },
    ]),
    { side: "new", line_start: 12, line_end: 12, col_start: 6, col_end: 18 },
  );
});

test("lines diff2html printed no number for are left out of the anchor", () => {
  assert.deepEqual(anchorFor([{}, { new: 7 }, {}]), {
    side: "new",
    line_start: 7,
    line_end: 7,
  });
});

test("without a single line number there is no anchor: a guessed line is worse than none", () => {
  assert.equal(anchorFor([{}, {}]), undefined);
  assert.equal(anchorFor([]), undefined);
});

test("an annotation carries the anchor of its fragment", () => {
  const prompts = annotationsFrom(
    [{ ...fragment("a.ts", "+x"), anchor: { side: "new", line_start: 12, line_end: 14 } }],
    "why?",
  );

  assert.equal(prompts[0]!.side, "new");
  assert.equal(prompts[0]!.line_start, 12);
  assert.equal(prompts[0]!.line_end, 14);
});

test("an annotation without an anchor leaves the fields absent", () => {
  const [prompt] = annotationsFrom([fragment("a.ts", "+x")], "why?");

  assert.equal("line_start" in prompt!, false);
  assert.equal("line_end" in prompt!, false);
  assert.equal("side" in prompt!, false);
});

test("fragments of one file on the same side merge into the range they span", () => {
  const prompts = annotationsFrom(
    [
      { ...fragment("a.ts", "+x"), anchor: { side: "new", line_start: 12, line_end: 14 } },
      { ...fragment("a.ts", "+y"), anchor: { side: "new", line_start: 30, line_end: 31 } },
    ],
    "why?",
  );

  assert.deepEqual(
    [prompts[0]!.side, prompts[0]!.line_start, prompts[0]!.line_end],
    ["new", 12, 31],
  );
});

test("an annotation carries the columns of its fragment", () => {
  const prompts = annotationsFrom(
    [
      {
        ...fragment("a.ts", "fetchUser(id)"),
        anchor: { side: "new", line_start: 12, line_end: 12, col_start: 14, col_end: 26 },
      },
    ],
    "why?",
  );

  assert.equal(prompts[0]!.col_start, 14);
  assert.equal(prompts[0]!.col_end, 26);
});

test("an annotation on whole lines leaves the column fields absent", () => {
  const [prompt] = annotationsFrom(
    [{ ...fragment("a.ts", "+x"), anchor: { side: "new", line_start: 12, line_end: 14 } }],
    "why?",
  );

  assert.equal("col_start" in prompt!, false);
  assert.equal("col_end" in prompt!, false);
});

test("merged fragments keep the outermost columns of the range they span", () => {
  const prompts = annotationsFrom(
    [
      {
        ...fragment("a.ts", "x"),
        anchor: { side: "new", line_start: 12, line_end: 12, col_start: 9, col_end: 20 },
      },
      {
        ...fragment("a.ts", "y"),
        anchor: { side: "new", line_start: 12, line_end: 12, col_start: 4, col_end: 30 },
      },
    ],
    "why?",
  );

  assert.equal(prompts[0]!.col_start, 4);
  assert.equal(prompts[0]!.col_end, 30);
});

test("a fragment taking a boundary line whole drops the column the other one had", () => {
  const prompts = annotationsFrom(
    [
      {
        ...fragment("a.ts", "x"),
        anchor: { side: "new", line_start: 12, line_end: 12, col_start: 9, col_end: 20 },
      },
      { ...fragment("a.ts", "y"), anchor: { side: "new", line_start: 12, line_end: 14 } },
    ],
    "why?",
  );

  assert.equal("col_start" in prompts[0]!, false);
  // Line 14 is the end of the merged range, and only the second fragment
  // reaches it, so nothing there was clipped either.
  assert.equal("col_end" in prompts[0]!, false);
});

test("fragments of one file on opposite sides drop the anchor rather than pick a side", () => {
  const prompts = annotationsFrom(
    [
      { ...fragment("a.ts", "-x"), anchor: { side: "old", line_start: 40, line_end: 41 } },
      { ...fragment("a.ts", "+y"), anchor: { side: "new", line_start: 12, line_end: 14 } },
    ],
    "why?",
  );

  assert.equal(prompts.length, 1);
  assert.equal("side" in prompts[0]!, false);
});

test("an unanchored fragment does not erase the anchor of its file's other fragment", () => {
  const prompts = annotationsFrom(
    [
      { ...fragment("a.ts", "+x"), anchor: { side: "new", line_start: 12, line_end: 14 } },
      fragment("a.ts", "+y"),
    ],
    "why?",
  );

  assert.deepEqual(
    [prompts[0]!.side, prompts[0]!.line_start, prompts[0]!.line_end],
    ["new", 12, 14],
  );
});

test("previews long selections with an ellipsis so the popup stays small", () => {
  const preview = selectionPreview("+".repeat(400), 120);

  assert.equal(preview.length, 121);
  assert.match(preview, /…$/);
});

test("a short selection is papproved as-is", () => {
  assert.equal(selectionPreview("+const user = 1;", 120), "+const user = 1;");
});

test("the popup names every file the selection touches and previews the text", () => {
  const html = renderAnnotationPopup([
    fragment("src/api/users.ts", "+const user = 1;"),
    fragment("src/api/orders.ts", "-const order = 2;"),
  ]);

  assert.match(html, /src\/api\/users.ts/);
  assert.match(html, /src\/api\/orders.ts/);
  assert.match(html, /\+const user = 1;/);
  assert.match(html, /<textarea[^>]*id="lsr-annotation-comment"/);
  assert.match(html, /id="lsr-queue-feedback"[^>]*>Queue Feedback</);
});

test("the popup previews the selected characters, not the lines they sit in", () => {
  const html = renderAnnotationPopup([fragment("src/api/users.ts", "fetchUser(id)")]);

  assert.match(html, /<pre class="lsr-popup-preview">fetchUser\(id\)<\/pre>/);
});

test("the popup escapes file paths and selected text", () => {
  const html = renderAnnotationPopup([fragment("<script>.ts", "+<img src=x>")]);

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x&gt;/);
});

test("the popup comment box asks for feedback in as few words as possible", () => {
  const html = renderAnnotationPopup([{ file: "a.ts", group: "API", text: "+x" }]);
  assert.match(html, /placeholder="Type feedback, then press Enter"/);
});
