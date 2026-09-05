import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  applyNewline,
  enterAction,
  typeNewline,
  type EditableField,
  type EnterKeydown,
} from "../../../src/browser/dom/enter-key.ts";

function keydown(over: Partial<EnterKeydown> = {}): EnterKeydown {
  return {
    key: "Enter",
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    ...over,
  };
}

function field(over: Partial<EditableField> = {}): EditableField {
  const box: EditableField = {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    setSelectionRange(start, end) {
      box.selectionStart = start;
      box.selectionEnd = end;
    },
    ...over,
  };
  return box;
}

test("a bare Enter submits the comment", () => {
  assert.equal(enterAction(keydown()), "submit");
});

test("Shift+Enter is left to the browser, which types the newline itself", () => {
  assert.equal(enterAction(keydown({ shiftKey: true })), "default");
  assert.equal(enterAction(keydown({ altKey: true })), "default");
});

test("Ctrl+Enter and Cmd+Enter ask for a newline the browser does not type", () => {
  assert.equal(enterAction(keydown({ ctrlKey: true })), "newline");
  assert.equal(enterAction(keydown({ metaKey: true })), "newline");
});

test("an Enter that ends an IME composition belongs to the composition", () => {
  assert.equal(enterAction(keydown({ isComposing: true })), "default");
});

test("every other key is the browser's", () => {
  assert.equal(enterAction(keydown({ key: "Escape" })), "default");
  assert.equal(enterAction(keydown({ key: "a" })), "default");
  assert.equal(enterAction(keydown({ key: "Escape", ctrlKey: true })), "default");
});

test("a newline is typed at the caret, which lands after it", () => {
  const box = field({ value: "onetwo", selectionStart: 3, selectionEnd: 3 });

  applyNewline(box);

  assert.equal(box.value, "one\ntwo");
  assert.equal(box.selectionStart, 4);
  assert.equal(box.selectionEnd, 4);
});

test("a newline replaces the selected text, as typing any character would", () => {
  const box = field({ value: "one BAD two", selectionStart: 4, selectionEnd: 7 });

  applyNewline(box);

  assert.equal(box.value, "one \n two");
  assert.equal(box.selectionStart, 5);
});

test("a field reporting no caret takes the newline at its end", () => {
  const box = field({ value: "one", selectionStart: null, selectionEnd: null });

  applyNewline(box);

  assert.equal(box.value, "one\n");
  assert.equal(box.selectionStart, 4);
});

/** Stands a browser's `execCommand` up for one test, restoring the global after. */
function stubExecCommand(t: TestContext, inserts: boolean): { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const globals = globalThis as Record<string, unknown>;
  const before = globals.document;
  globals.document = {
    execCommand: (...args: unknown[]) => {
      calls.push(args);
      return inserts;
    },
  };
  t.after(() => {
    globals.document = before;
  });
  return { calls };
}

test("the browser types the newline itself when it can, keeping the undo stack", (t) => {
  const { calls } = stubExecCommand(t, true);
  const box = field({ value: "onetwo", selectionStart: 3, selectionEnd: 3 });

  typeNewline(box);

  assert.deepEqual(calls, [["insertText", false, "\n"]]);
  assert.equal(box.value, "onetwo", "the field is not written twice");
});

test("a refused insertText falls back to splicing the newline in", (t) => {
  stubExecCommand(t, false);
  const box = field({ value: "onetwo", selectionStart: 3, selectionEnd: 3 });

  typeNewline(box);

  assert.equal(box.value, "one\ntwo");
});

test("a page without execCommand still gets its newline", () => {
  const box = field({ value: "onetwo", selectionStart: 3, selectionEnd: 3 });

  typeNewline(box);

  assert.equal(box.value, "one\ntwo");
});
