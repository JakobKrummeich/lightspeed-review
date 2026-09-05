import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountDonePopup } from "../../../src/browser/dom/done-popup.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

/** The page as far as the popup touches it: the Esc listener, and who holds the caret. */
class FakeDocument {
  private listeners = new Map<string, ((event: unknown) => void)[]>();
  activeElement: FakeNode | null = null;

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

function mounted(t: TestContext): {
  root: FakeNode;
  page: FakeDocument;
  /** The box the reviewer's last tick left the caret in. */
  tick: FakeNode;
  ended: number[];
  open(queued?: number): void;
  close(): void;
  click(selector: string): void;
} {
  installFakeElements((undo) => t.after(undo));
  const page = new FakeDocument();
  const globals = globalThis as Record<string, unknown>;
  const before = globals.document;
  globals.document = page;
  t.after(() => {
    globals.document = before;
  });
  const tick = new FakeNode("input", 'class="lsr-tick-all"');
  page.activeElement = tick;
  const root = new FakeNode("div", 'id="lsr-done-popup" hidden');
  const ended: number[] = [];
  const popup = mountDonePopup({
    root: asPanelRoot(root),
    onEnd: () => ended.push(1),
  });
  return {
    root,
    page,
    tick,
    ended,
    open: (queued = 0) => popup.open(queued),
    close: () => popup.close(),
    click: (selector: string) => {
      const target = root.querySelector(selector);
      assert.ok(target, `${selector} is on screen`);
      root.dispatch("click", { target });
    },
  };
}

test("the last tick puts the finish over the review, with the end press under the caret", (t) => {
  const { root, open, page } = mounted(t);

  open();

  assert.equal(root.hidden, false);
  assert.match(root.innerHTML, /Every file is approved/);
  assert.equal(root.querySelector(".lsr-done-end")?.focused, true, "Enter ends the review");
  assert.equal(page.keydownCount(), 1, "Esc is listened for while the card is up");
});

test("the card's own end press says the word once and takes the card down first", (t) => {
  const { root, open, ended, click, tick } = mounted(t);
  open();

  click(".lsr-done-end");

  assert.deepEqual(ended, [1]);
  assert.equal(root.hidden, true);
  assert.equal(root.innerHTML, "");
  assert.equal(tick.focused, true, "the caret goes back where the reviewer left it");
});

test("keep looking takes the card down and ends nothing", (t) => {
  const { root, open, ended, click, page } = mounted(t);
  open();

  click(".lsr-done-stay");

  assert.deepEqual(ended, []);
  assert.equal(root.hidden, true);
  assert.equal(page.keydownCount(), 0, "a closed card listens for nothing");
});

test("Esc is keep looking", (t) => {
  const { root, open, ended, page } = mounted(t);
  open();

  page.press("Escape");

  assert.equal(root.hidden, true);
  assert.deepEqual(ended, []);
  assert.equal(page.keydownCount(), 0);
});

test("a finish that comes undone takes its card with it; one already down is left alone", (t) => {
  const { root, open, close, page, tick } = mounted(t);
  open();

  close();
  assert.equal(root.hidden, true);
  assert.equal(tick.focused, true);

  tick.focused = false;
  close();
  assert.equal(tick.focused, false, "nothing to close, so nothing is moved");
  assert.equal(page.keydownCount(), 0);
});

test("the card says what ending carries, and a newer word replaces an older card without a second caret", (t) => {
  const { root, open, page } = mounted(t);

  open(2);
  assert.match(root.innerHTML, /Your 2 queued notes go with it/);

  open(0);
  assert.doesNotMatch(root.innerHTML, /queued/);
  assert.equal(page.keydownCount(), 1, "one Esc listener, not one per word");
});
