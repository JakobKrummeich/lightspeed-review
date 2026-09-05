import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PANEL_WIDTH_PX,
  VIEW_FORMAT_OPTIONS,
  WIDE_VIEWPORT_QUERY,
  effectiveFormat,
  roomQuery,
  parseViewFormat,
  readViewFormat,
  writeViewFormat,
} from "../../src/browser/view-format.ts";

function fakeStorage(seed: Record<string, string> = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
  };
}

test("a reviewer who never chose a view gets the unified one", () => {
  assert.equal(readViewFormat(fakeStorage(), "abc123"), "line-by-line");
});

test("the chosen view is remembered for that session", () => {
  const storage = fakeStorage();

  writeViewFormat(storage, "abc123", "side-by-side");

  assert.equal(readViewFormat(storage, "abc123"), "side-by-side");
});

test("another session keeps its own view", () => {
  const storage = fakeStorage();

  writeViewFormat(storage, "abc123", "side-by-side");

  assert.equal(readViewFormat(storage, "def456"), "line-by-line");
});

test("a stored value that is not a known format is ignored", () => {
  const storage = { getItem: () => "wide-mode", setItem: () => {} };

  assert.equal(readViewFormat(storage, "abc123"), "line-by-line");
});

test("storage that refuses to answer does not break the view", () => {
  const storage = {
    getItem: (): string | null => {
      throw new Error("storage disabled");
    },
    setItem: () => {
      throw new Error("storage disabled");
    },
  };

  assert.equal(readViewFormat(storage, "abc123"), "line-by-line");
  assert.doesNotThrow(() => writeViewFormat(storage, "abc123", "side-by-side"));
});

test("side by side falls back to unified when the viewport is too narrow for two columns", () => {
  assert.equal(effectiveFormat("side-by-side", false), "line-by-line");
});

test("side by side survives on a wide enough viewport", () => {
  assert.equal(effectiveFormat("side-by-side", true), "side-by-side");
});

test("the unified view is used at any width", () => {
  assert.equal(effectiveFormat("line-by-line", true), "line-by-line");
  assert.equal(effectiveFormat("line-by-line", false), "line-by-line");
});

test("the width the two columns plus the conversation panel need", () => {
  assert.equal(WIDE_VIEWPORT_QUERY, "(min-width: 1400px)");
  assert.equal(roomQuery(false), WIDE_VIEWPORT_QUERY);
});

test("a shut panel lowers that width by exactly the panel", () => {
  // Otherwise the breakpoint keeps hiding side-by-side at widths where it now
  // fits, because it is still counting a column that is not on screen.
  const width = (query: string) => Number(/(\d+)px/.exec(query)?.[1]);

  assert.equal(width(roomQuery(false)) - width(roomQuery(true)), PANEL_WIDTH_PX);
});

test("the switch offers both views, each labelled with the view it shows", () => {
  assert.deepEqual(VIEW_FORMAT_OPTIONS, [
    { format: "line-by-line", label: "Unified" },
    { format: "side-by-side", label: "Side-by-side" },
  ]);
});

test("a format read off the DOM is only trusted when it is a known one", () => {
  assert.equal(parseViewFormat("side-by-side"), "side-by-side");
  assert.equal(parseViewFormat("line-by-line"), "line-by-line");
  assert.equal(parseViewFormat("wide-mode"), undefined);
  assert.equal(parseViewFormat(undefined), undefined);
});
