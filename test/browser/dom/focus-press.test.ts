import { test } from "node:test";
import assert from "node:assert/strict";
import { focusPress, indexPress } from "../../../src/browser/dom/focus-press.ts";

/** The two things the decoder reads off a pressed element: one class and the dataset. */
function control(cls: string, dataset: Record<string, string> = {}): HTMLElement {
  return {
    classList: { contains: (name: string) => name === cls },
    dataset,
  } as unknown as HTMLElement;
}

test("a press with no chapter index asks for nothing, not for the overview", () => {
  // Undefined `to` means "the overview"; a missing attribute must not read as it.
  assert.equal(indexPress(control("lsr-progress-segment")), undefined);
  assert.equal(focusPress(control("lsr-index-entry"), 1, 3), undefined);
});

test("an index entry asks for the chapter it names, from the overview or a chapter", () => {
  assert.deepEqual(focusPress(control("lsr-index-entry", { groupIndex: "2" }), undefined, 3), {
    to: 2,
  });
  assert.deepEqual(focusPress(control("lsr-index-entry", { groupIndex: "0" }), 1, 3), { to: 0 });
});

test("exit asks for the overview, and prev and next stop at the ends", () => {
  assert.deepEqual(focusPress(control("lsr-focus-exit"), 1, 3), { to: undefined });
  assert.deepEqual(focusPress(control("lsr-focus-next"), 1, 3), { to: 2 });
  assert.equal(focusPress(control("lsr-focus-next"), 2, 3), undefined);
  assert.equal(focusPress(control("lsr-focus-prev"), 0, 3), undefined);
  assert.equal(focusPress(control("lsr-focus-prev"), undefined, 3), undefined);
});
