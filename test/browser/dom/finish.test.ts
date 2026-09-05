import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { wireFinish, type FinishSide } from "../../../src/browser/dom/finish.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

/** The page as far as the card touches it. */
class FakeDocument {
  activeElement: FakeNode | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
}

function wired(t: TestContext): {
  root: FakeNode;
  finish: ReturnType<typeof wireFinish>;
  /** What the panel and the rail were told, in order. */
  log: string[];
  side: FinishSide;
} {
  installFakeElements((undo) => t.after(undo));
  const globals = globalThis as Record<string, unknown>;
  const before = globals.document;
  globals.document = new FakeDocument();
  t.after(() => {
    globals.document = before;
  });
  const root = new FakeNode("div", 'id="lsr-done-popup" hidden');
  const log: string[] = [];
  const side = {
    railControl: { expand: () => log.push("expand") },
    panel: {
      setAllApproved: (complete: boolean) => log.push(`note:${complete}`),
      end: () => log.push("end"),
    },
  } as unknown as FinishSide;
  return { root, finish: wireFinish(asPanelRoot(root)), log, side };
}

test("the report from before the panel existed is handed over when it is built", (t) => {
  const { finish, log, side, root } = wired(t);

  finish.onApproved(true);
  assert.deepEqual(log, [], "nothing to tell yet");
  assert.equal(root.hidden, true, "the state the page opened in is not a finish");

  finish.attach(side);
  assert.deepEqual(log, ["note:true"]);
});

test("the crossing opens the rail and the card, with the queue's size on it", (t) => {
  const { finish, log, side, root } = wired(t);
  finish.attach(side);
  finish.onApproved(false);
  finish.setQueued(2);

  finish.onApproved(true);

  // Attach hands over the remembered report; the panel is what dedupes, not this.
  assert.deepEqual(log, ["note:false", "note:false", "note:true", "expand"]);
  assert.equal(root.hidden, false);
  assert.match(root.innerHTML, /Your 2 queued notes go with it/);
});

test("the card's end press is the panel's send, and a finish undone takes the card down", (t) => {
  const { finish, log, side, root } = wired(t);
  finish.attach(side);
  finish.onApproved(false);
  finish.onApproved(true);

  root.dispatch("click", { target: root.querySelector(".lsr-done-end") });
  assert.equal(log.at(-1), "end");
  assert.equal(root.hidden, true);

  finish.onApproved(true);
  assert.equal(root.hidden, true, "still finished: no crossing, no second card");
  finish.onApproved(false);
  finish.onApproved(true);
  assert.equal(root.hidden, false, "finished again, so said again");
  finish.onApproved(false);
  assert.equal(root.hidden, true, "a box came unticked under the card");
});
