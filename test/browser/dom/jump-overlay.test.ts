import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { playJump } from "../../../src/browser/dom/jump-overlay.ts";
import type { Stillness } from "../../../src/browser/dom/stillness.ts";
import { SKY_TIMES } from "../../../src/browser/starfield.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

class FakeDocument {
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((known) => known !== handler),
    );
  }

  press(key: string): void {
    for (const handler of this.listeners.get("keydown") ?? []) handler({ key });
  }

  keydownCount(): number {
    return (this.listeners.get("keydown") ?? []).length;
  }
}

const MOVING: Stillness = { reducedMotion: false, forcedColors: false };

function jumped(t: TestContext, still: Stillness = MOVING) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installFakeElements((undo) => t.after(undo));
  const page = new FakeDocument();
  const globals = globalThis as Record<string, unknown>;
  const before = globals.document;
  globals.document = page;
  t.after(() => {
    globals.document = before;
  });
  const root = new FakeNode("div", 'id="lsr-opening"');
  const state = { root, page, lands: 0 };
  playJump({ root: asPanelRoot(root), still, land: () => (state.lands += 1) });
  return state;
}

test("the round arrives by a jump that fills the window, and lands after it", (t) => {
  const state = jumped(t);
  const field = state.root.querySelector(".lsr-jump-overlay");

  assert.ok(field, "the room is up");
  assert.equal(state.lands, 0, "the replay waits for the landing");
  assert.ok(state.root.querySelector(".lsr-sky-canvas"));

  t.mock.timers.tick(SKY_TIMES.flashAtMs);
  assert.equal(field.dataset.bloom, "true", "the flash covers the swap");
  assert.equal(state.lands, 0);

  t.mock.timers.tick(SKY_TIMES.jumpMs - SKY_TIMES.flashAtMs);
  assert.equal(state.lands, 1);
  assert.equal(state.root.innerHTML, "", "nothing of the room is left");
  assert.equal(state.page.keydownCount(), 0);
});

test("the room is decoration only: hidden from a reader, and it takes no caret", (t) => {
  const { root } = jumped(t);

  assert.match(root.innerHTML, /class="lsr-jump-overlay" aria-hidden="true"/);
  assert.doesNotMatch(root.innerHTML, /<button|tabindex/);
});

test("Esc lands at once, and the jump's own timers land nothing more", (t) => {
  const state = jumped(t);

  state.page.press("Escape");
  assert.equal(state.lands, 1);
  assert.equal(state.root.innerHTML, "");

  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(state.lands, 1, "one landing, however it came");
  assert.equal(state.page.keydownCount(), 0);
});

test("an ordinary key is not a way out", (t) => {
  const state = jumped(t);

  state.page.press("a");

  assert.equal(state.lands, 0);
});

for (const still of [
  { reducedMotion: true, forcedColors: false },
  { reducedMotion: false, forcedColors: true },
]) {
  test(`${JSON.stringify(still)} skips the jump: the round lands at once`, (t) => {
    const state = jumped(t, still);

    assert.equal(state.lands, 1);
    assert.equal(state.root.innerHTML, "", "no room drawn at all");
    assert.equal(state.page.keydownCount(), 0);
  });
}
