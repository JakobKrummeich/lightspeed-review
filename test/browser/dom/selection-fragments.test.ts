import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionFragments } from "../../../src/browser/dom/selection-fragments.ts";
import {
  asSelection,
  diffFileBlock,
  diffRoot,
  fakeRange,
  sideBySideBlock,
  type FakeCodeLine,
  type FakeElement,
} from "./fake-dom.ts";

const usersFile = () =>
  diffFileBlock({
    file: "src/api/users.ts",
    group: "API Handlers",
    lines: [
      { new: 12, prefix: "+", pieces: ["const user = fetchUser(id);"] },
      { new: 13, prefix: "+", pieces: ["const order = fetchOrder(id);"] },
      { new: 14, prefix: "+", pieces: ["return { user, order };"] },
    ],
  });

/** The text node holding one line's code, which is where a drag lands. */
const textOf = (line: FakeCodeLine): FakeCodeLine["texts"][number] => line.texts[0]!;

function fragmentsOf(
  root: FakeElement,
  start: { line: FakeCodeLine; offset: number },
  end: { line: FakeCodeLine; offset: number },
) {
  const range = fakeRange(
    root,
    { node: textOf(start.line), offset: start.offset },
    { node: textOf(end.line), offset: end.offset },
  );
  return selectionFragments(asSelection(range), root as unknown as HTMLElement);
}

test("part of a line is quoted as the reviewer marked it, not as the whole line", () => {
  const { block, lines } = usersFile();
  const root = diffRoot(block);

  const [fragment] = fragmentsOf(
    root,
    { line: lines[0]!, offset: 13 },
    { line: lines[0]!, offset: 26 },
  );

  assert.equal(fragment?.text, "fetchUser(id)");
  assert.equal(fragment?.file, "src/api/users.ts");
  assert.equal(fragment?.group, "API Handlers");
});

test("the columns of a part-line selection reach the anchor the agent is sent", () => {
  const { block, lines } = usersFile();
  const root = diffRoot(block);

  const [fragment] = fragmentsOf(
    root,
    { line: lines[0]!, offset: 13 },
    { line: lines[0]!, offset: 26 },
  );

  assert.deepEqual(fragment?.anchor, {
    side: "new",
    line_start: 12,
    line_end: 12,
    col_start: 14,
    col_end: 26,
  });
});

test("a multi-line selection clips its ends and keeps the lines between them whole", () => {
  const { block, lines } = usersFile();
  const root = diffRoot(block);

  const [fragment] = fragmentsOf(
    root,
    { line: lines[0]!, offset: 6 },
    { line: lines[2]!, offset: 6 },
  );

  assert.equal(fragment?.text, "user = fetchUser(id);\n+const order = fetchOrder(id);\nreturn");
  assert.deepEqual(fragment?.anchor, {
    side: "new",
    line_start: 12,
    line_end: 14,
    col_start: 7,
    col_end: 6,
  });
});

test("a line the selection stops at is left out, marker and all", () => {
  const { block, lines } = usersFile();
  const root = diffRoot(block);

  // The drag ends where the second line's code begins: nothing of it is marked,
  // and the range still reports the line as intersected.
  const [fragment] = fragmentsOf(
    root,
    { line: lines[0]!, offset: 6 },
    { line: lines[1]!, offset: 0 },
  );

  assert.equal(fragment?.text, "user = fetchUser(id);");
  assert.equal(fragment?.anchor?.line_end, 12);
});

test("whole lines still carry their marker and no columns at all", () => {
  const { block, lines } = usersFile();
  const root = diffRoot(block);

  const [fragment] = fragmentsOf(
    root,
    { line: lines[0]!, offset: 0 },
    { line: lines[1]!, offset: 29 },
  );

  assert.equal(fragment?.text, "+const user = fetchUser(id);\n+const order = fetchOrder(id);");
  assert.deepEqual(fragment?.anchor, { side: "new", line_start: 12, line_end: 13 });
});

test("a selection across two files becomes one fragment per file", () => {
  const users = usersFile();
  const orders = diffFileBlock({
    file: "src/api/orders.ts",
    group: "Cleanup",
    lines: [{ old: 40, prefix: "-", pieces: ["const legacy = true;"] }],
  });
  const root = diffRoot(users.block, orders.block);

  const fragments = fragmentsOf(
    root,
    { line: users.lines[2]!, offset: 7 },
    { line: orders.lines[0]!, offset: 12 },
  );

  assert.deepEqual(
    fragments.map((fragment) => [fragment.file, fragment.text, fragment.anchor]),
    [
      [
        "src/api/users.ts",
        "{ user, order };",
        { side: "new", line_start: 14, line_end: 14, col_start: 8, col_end: 23 },
      ],
      [
        "src/api/orders.ts",
        "const legacy",
        { side: "old", line_start: 40, line_end: 40, col_start: 1, col_end: 12 },
      ],
    ],
  );
});

test("a file showing what changed since its approval is not annotatable", () => {
  // Those lines are numbered against two history commits; the ledger's anchors are facts about
  // the branch diff. One recorded as the other points the agent at code nobody marked.
  const { block, lines } = usersFile();
  block.dataset.form = "approved";
  const root = diffRoot(block);

  assert.deepEqual(
    fragmentsOf(root, { line: lines[0]!, offset: 1 }, { line: lines[0]!, offset: 5 }),
    [],
  );
});

test("only the branch diff is annotatable, not merely 'anything but the approved form'", () => {
  // An allowlist: a third view added later must be argued for, not anchored against the branch
  // diff because nobody remembered to deny it.
  const { block, lines } = usersFile();
  block.dataset.form = "whatever-comes-next";
  const root = diffRoot(block);

  assert.deepEqual(
    fragmentsOf(root, { line: lines[0]!, offset: 1 }, { line: lines[0]!, offset: 5 }),
    [],
  );
});

test("a selection over both views annotates only the file showing the branch diff", () => {
  const users = usersFile();
  users.block.dataset.form = "approved";
  const orders = diffFileBlock({
    file: "src/api/orders.ts",
    group: "Cleanup",
    lines: [{ old: 40, prefix: "-", pieces: ["const legacy = true;"] }],
  });
  orders.block.dataset.form = "branch";
  const root = diffRoot(users.block, orders.block);

  const fragments = fragmentsOf(
    root,
    { line: users.lines[2]!, offset: 7 },
    { line: orders.lines[0]!, offset: 12 },
  );

  assert.deepEqual(
    fragments.map((fragment) => fragment.file),
    ["src/api/orders.ts"],
  );
});

test("a block without a path is not annotatable: the agent would have no file", () => {
  const { block, lines } = usersFile();
  delete (block.dataset as Record<string, string | undefined>).file;
  const root = diffRoot(block);

  assert.deepEqual(
    fragmentsOf(root, { line: lines[0]!, offset: 1 }, { line: lines[0]!, offset: 5 }),
    [],
  );
});

test("a drag that ends on a row stops in front of that row's code", () => {
  const { block, lines } = usersFile();
  const root = diffRoot(block);
  // Dragging past a line's end, browsers report the end on the row + child index: child 1 is the
  // code cell, so this end is before the second line's first character.
  const row = lines[1]!.line.parent!;
  const range = fakeRange(root, { node: textOf(lines[0]!), offset: 6 }, { node: row, offset: 1 });

  const [fragment] = selectionFragments(asSelection(range), root as unknown as HTMLElement);

  assert.equal(fragment?.text, "user = fetchUser(id);");
  assert.deepEqual(fragment?.anchor, {
    side: "new",
    line_start: 12,
    line_end: 12,
    col_start: 7,
    col_end: 27,
  });
});

test("a part-line selection in the right column of a side-by-side file is new code", () => {
  const { block, new: right } = sideBySideBlock({
    file: "src/api/users.ts",
    old: [{ old: 12, prefix: " ", pieces: ["const user = getUser(id);"] }],
    new: [{ new: 12, prefix: "+", pieces: ["const user = fetchUser(id);"] }],
  });
  const root = diffRoot(block);
  const range = fakeRange(
    root,
    { node: textOf(right[0]!), offset: 13 },
    { node: textOf(right[0]!), offset: 26 },
  );

  const [fragment] = selectionFragments(asSelection(range), root as unknown as HTMLElement);

  assert.equal(fragment?.text, "fetchUser(id)");
  assert.deepEqual(fragment?.anchor, {
    side: "new",
    line_start: 12,
    line_end: 12,
    col_start: 14,
    col_end: 26,
  });
});

test("a collapsed selection yields nothing, so a plain click opens no popup", () => {
  const { block, lines } = usersFile();
  const root = diffRoot(block);
  // A click leaves a collapsed range; on the `+` marker it covers no code, which would otherwise
  // read as a whole line — only its being collapsed says nothing was marked.
  const marker = lines[0]!.line.querySelector(".d2h-code-line-prefix")!.childNodes[0]!;
  const clicked = fakeRange(root, { node: marker, offset: 0 }, { node: marker, offset: 0 });

  assert.deepEqual(
    selectionFragments(asSelection(clicked, true), root as unknown as HTMLElement),
    [],
  );
  assert.deepEqual(selectionFragments(asSelection(undefined), root as unknown as HTMLElement), []);
});
