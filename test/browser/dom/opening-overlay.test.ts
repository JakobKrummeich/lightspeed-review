import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountOpening } from "../../../src/browser/dom/opening-overlay.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

/**
 * The page as far as the overlay touches it: the Esc listener and the element
 * holding focus. Listeners removed by identity, so a leak shows as a second close.
 */
class FakeDocument {
  activeElement: FakeNode | null = null;
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

interface Mounted {
  root: FakeNode;
  page: FakeDocument;
  opens: number;
  closes: number;
}

function mounted(t: TestContext, intents: string[], held?: FakeNode): Mounted {
  installFakeElements((undo) => t.after(undo));
  const page = new FakeDocument();
  const globals = globalThis as Record<string, unknown>;
  const before = globals.document;
  globals.document = page;
  t.after(() => {
    globals.document = before;
  });
  // Whatever held the caret at load — where the close must put it back.
  page.activeElement = held ?? null;
  const root = new FakeNode("div", 'id="lsr-opening"');
  const state: Mounted = { root, page, opens: 0, closes: 0 };
  mountOpening({
    root: asPanelRoot(root),
    intents,
    onOpen: () => (state.opens += 1),
    onClose: () => (state.closes += 1),
  });
  return state;
}

/** Where each sheet stands: peeled away, on top, or still to come. */
function places(root: FakeNode): (string | undefined)[] {
  return root.querySelectorAll(".lsr-opening-sheet").map((sheet) => sheet.dataset.at);
}

function lit(root: FakeNode): (string | undefined)[] {
  return root.querySelectorAll(".lsr-opening-dot").map((dot) => dot.dataset.on);
}

function presses(root: FakeNode): FakeNode[] {
  return root.querySelectorAll(".lsr-opening-press");
}

function press(root: FakeNode, index: number): void {
  const button = presses(root)[index];
  assert.ok(button, `sheet ${index} has a button`);
  button.dispatch("click", {});
}

/** The room itself: what the flare and the flood are written on. */
function room(root: FakeNode): FakeNode {
  const field = root.querySelector(".lsr-opening-overlay");
  assert.ok(field, "the stack is in a room");
  return field;
}

test("the stack goes up with the cover on top and the caret on its button", (t) => {
  const { root, opens } = mounted(t, ["one", "two"]);

  assert.deepEqual(places(root), ["top", "under", "under"]);
  assert.equal(presses(root)[0]?.focused, true);
  assert.equal(opens, 1, "the wrapper counts as opened the moment it is on screen");
});

test("a press peels exactly one sheet and the dots follow it", (t) => {
  const { root } = mounted(t, ["one", "two"]);

  press(root, 0);

  assert.deepEqual(places(root), ["gone", "top", "under"]);
  assert.deepEqual(lit(root), ["true", "true", "false"]);

  press(root, 1);

  assert.deepEqual(places(root), ["gone", "gone", "top"]);
  assert.deepEqual(lit(root), ["true", "true", "true"]);
});

test("every press strikes the room, and the strike is over before the next one", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root } = mounted(t, ["one", "two"]);
  const field = room(root);

  press(root, 0);
  assert.equal(field.dataset.flare, "true", "the reward is on the press itself");

  t.mock.timers.tick(160);
  assert.equal(field.dataset.flare, "false", "a strike that outstays its press is a glow");

  press(root, 1);
  assert.equal(field.dataset.flare, "true");
});

test("the last press floods the room, and the review is under the light when it fades", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one"]);
  const field = room(state.root);

  press(state.root, 0);
  press(state.root, 1);

  assert.equal(field.dataset.bloom, "true");
  assert.notEqual(state.root.innerHTML, "", "the room is still up while it floods");
  assert.equal(state.closes, 0);

  t.mock.timers.tick(260);

  assert.equal(state.root.innerHTML, "");
  assert.equal(state.closes, 1);
});

test("nothing answers a press once the room is on its way out", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one"]);
  const field = room(state.root);

  press(state.root, 0);
  press(state.root, 1);
  t.mock.timers.tick(160);
  // A reviewer pressing twice on the way out must not light the room again
  // over a review that is already being handed to them.
  press(state.root, 1);

  assert.equal(field.dataset.flare, "false");

  t.mock.timers.tick(260);
  assert.equal(state.closes, 1, "one way out, however many times it was pressed");
});

test("Esc leaves at once and without the flood: it is a way out, not a reward", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one", "two"]);
  const field = room(state.root);

  state.page.press("Escape");

  assert.equal(field.dataset.bloom, "false");
  assert.equal(state.root.innerHTML, "");
  assert.equal(state.closes, 1);
});

test("the caret moves to the sheet that arrived, not the one that left", (t) => {
  const { root } = mounted(t, ["one", "two"]);

  press(root, 0);
  assert.equal(presses(root)[1]?.focused, true);

  press(root, 1);
  assert.equal(presses(root)[2]?.focused, true);
});

test("the last sheet opens the review: nothing left on screen, and one close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one", "two"]);

  press(state.root, 0);
  press(state.root, 1);
  assert.notEqual(state.root.innerHTML, "", "a reason still standing is a reason still shown");

  press(state.root, 2);
  t.mock.timers.tick(260);

  assert.equal(state.root.innerHTML, "");
  assert.equal(state.closes, 1);
});

test("Esc lands on the review from the middle of the stack", (t) => {
  const state = mounted(t, ["one", "two", "three"]);
  press(state.root, 0);

  state.page.press("a");
  assert.notEqual(state.root.innerHTML, "", "an ordinary key is not a way out");

  state.page.press("Escape");
  assert.equal(state.root.innerHTML, "");
  assert.equal(state.closes, 1);
  assert.equal(state.page.keydownCount(), 0, "the listener went with the stack");

  state.page.press("Escape");
  assert.equal(state.closes, 1, "a second Escape has nothing left to close");
});

test("the wrapper is opened once, however the reviewer leaves it", (t) => {
  // Flag written the moment the stack goes up, not when it comes down: a
  // reload halfway through was already handed the round — no repeat ceremony.
  const state = mounted(t, ["one", "two"]);
  assert.equal(state.opens, 1);

  state.page.press("Escape");

  assert.deepEqual([state.opens, state.closes], [1, 1]);
});

test("focus goes back where it was, so a keyboard reviewer lands on the page", (t) => {
  const held = new FakeNode("button", 'id="lsr-panel-rail"');
  const state = mounted(t, ["one"], held);

  state.page.press("Escape");

  assert.equal(held.focused, true);
});

test("nothing to open is nothing shown: no stack, no listener, nothing reported", (t) => {
  const state = mounted(t, []);

  assert.equal(state.root.innerHTML, "");
  assert.equal(state.page.keydownCount(), 0);
  assert.deepEqual([state.opens, state.closes], [0, 0]);
});
