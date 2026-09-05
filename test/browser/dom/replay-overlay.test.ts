import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { DiffRenderer } from "../../../src/browser/diff-renderer.ts";
import {
  mountReplayOverlay,
  type ReplayOverlayControl,
} from "../../../src/browser/dom/replay-overlay.ts";
import type { ReplayComment, ReplayData } from "../../../src/rounds/replay.ts";
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

function comment(id: string): ReplayComment {
  return {
    id,
    file: `src/${id}.ts`,
    group: "API",
    anchor: null,
    selected_text: "+x",
    comment: `about ${id}`,
    status: "addressed",
    declared: true,
    state: "ok",
    answers: [],
    note: `note for ${id}`,
  };
}

function data(count: number): ReplayData {
  return { comments: Array.from({ length: count }, (_unused, index) => comment(`c${index}`)) };
}

const renderer: DiffRenderer = { renderFile: (diff) => `<pre>${diff}</pre>` };

function mounted(t: TestContext): {
  root: FakeNode;
  page: FakeDocument;
  overlay: ReplayOverlayControl;
  closes: number[];
} {
  installFakeElements((undo) => t.after(undo));
  const page = new FakeDocument();
  const globals = globalThis as Record<string, unknown>;
  const before = globals.document;
  globals.document = page;
  t.after(() => {
    globals.document = before;
  });
  const root = new FakeNode("div", 'id="lsr-replay"');
  const closes: number[] = [];
  const overlay = mountReplayOverlay({
    root: asPanelRoot(root),
    renderer,
    onClose: () => closes.push(1),
  });
  return { root, page, overlay, closes };
}

function progress(root: FakeNode): string {
  return root.querySelector(".lsr-replay-progress")?.textContent ?? "";
}

function click(root: FakeNode, selector: string): void {
  const target = root.querySelector(selector);
  assert.ok(target, `${selector} is on screen`);
  target.dispatch("click", {});
}

test("opening draws the first card and hands the caret to the primary button", (t) => {
  const { root, overlay } = mounted(t);

  overlay.open({ data: data(3) });

  assert.equal(progress(root), "Comment 1 of 3");
  assert.equal(root.querySelector(".lsr-replay-next")?.focused, true);
});

test("Next and Previous walk the cards, and the dots jump straight to one", (t) => {
  const { root, overlay } = mounted(t);
  overlay.open({ data: data(3) });

  click(root, ".lsr-replay-next");
  assert.equal(progress(root), "Comment 2 of 3");

  click(root, ".lsr-replay-prev");
  assert.equal(progress(root), "Comment 1 of 3");

  const dots = root.querySelectorAll(".lsr-replay-dot");
  assert.equal(dots.length, 3);
  dots[2]?.dispatch("click", {});
  assert.equal(progress(root), "Comment 3 of 3");
});

test("Done on the last card closes, empties the landmark and reports the close once", (t) => {
  const { root, overlay, closes } = mounted(t);
  overlay.open({ data: data(2) });

  click(root, ".lsr-replay-next");
  click(root, ".lsr-replay-next");

  assert.equal(root.innerHTML, "");
  assert.deepEqual(closes, [1]);
});

test("Skip to the diff closes from any card", (t) => {
  const { root, overlay, closes } = mounted(t);
  overlay.open({ data: data(3) });

  click(root, ".lsr-replay-skip");

  assert.equal(root.innerHTML, "");
  assert.deepEqual(closes, [1]);
});

test("Esc closes, and its listener does not outlive the dialog it was for", (t) => {
  const { root, overlay, closes, page } = mounted(t);
  overlay.open({ data: data(2) });

  page.press("a");
  assert.notEqual(root.innerHTML, "", "an ordinary key is not a way out");

  page.press("Escape");
  assert.equal(root.innerHTML, "");
  assert.deepEqual(closes, [1]);
  assert.equal(page.keydownCount(), 0, "the listener went with the dialog");

  page.press("Escape");
  assert.deepEqual(closes, [1], "a second Escape has nothing left to close");
});

test("focus goes back where it was, which is how the header control keeps the caret", (t) => {
  const { root, overlay, page } = mounted(t);
  const reopen = new FakeNode("button", 'id="lsr-replay-reopen"');
  page.activeElement = reopen;
  overlay.open({ data: data(1) });

  click(root, ".lsr-replay-skip");

  assert.equal(reopen.focused, true);
});

test("reopening starts the replay over from the first card", (t) => {
  const { root, overlay } = mounted(t);
  overlay.open({ data: data(3) });
  click(root, ".lsr-replay-next");
  click(root, ".lsr-replay-skip");

  overlay.open({ data: data(3) });

  assert.equal(progress(root), "Comment 1 of 3");
});

test("nothing to show is nothing shown: no dialog, no listener, no close to report", (t) => {
  const { root, overlay, closes, page } = mounted(t);

  overlay.open({ data: { comments: [] } });

  assert.equal(root.innerHTML, "");
  assert.equal(page.keydownCount(), 0);
  assert.deepEqual(closes, []);
});
