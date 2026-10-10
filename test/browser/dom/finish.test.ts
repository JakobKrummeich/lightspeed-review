import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { wireFinish, type FinishSide } from "../../../src/browser/dom/finish.ts";
import type { Turn } from "../../../src/session-store.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

class FakeDocument {
  activeElement: FakeNode | null = null;
  addEventListener(): void {}
  removeEventListener(): void {}
}

function wired(
  t: TestContext,
  opening: Turn = { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
): {
  root: FakeNode;
  finish: ReturnType<typeof wireFinish>;
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
  return { root, finish: wireFinish(asPanelRoot(root), opening), log, side };
}

test("the report from before the panel existed is handed over when it is built", (t) => {
  const { finish, log, side, root } = wired(t);

  finish.onApproved(true, false);
  assert.deepEqual(log, [], "nothing to tell yet");
  assert.equal(root.hidden, true, "the state the page opened in is not a finish");

  finish.attach(side);
  assert.deepEqual(log, ["note:true"]);
});

test("the crossing opens the rail and the card, with the queue's size on it", (t) => {
  const { finish, log, side, root } = wired(t);
  finish.attach(side);
  finish.onApproved(false, true);
  finish.setQueued(2);

  finish.onApproved(true, true);

  // Attach hands over the remembered report; the panel is what dedupes, not this.
  assert.deepEqual(log, ["note:false", "note:false", "note:true", "expand"]);
  assert.equal(root.hidden, false);
  assert.match(root.innerHTML, /Your 2 queued notes go with it/);
});

test("the card's end press is the panel's send, and a finish undone takes the card down", (t) => {
  const { finish, log, side, root } = wired(t);
  finish.attach(side);
  finish.onApproved(false, true);
  finish.onApproved(true, true);

  root.dispatch("click", { target: root.querySelector(".lsr-done-end") });
  assert.equal(log.at(-1), "end");
  assert.equal(root.hidden, true);

  finish.onApproved(true, true);
  assert.equal(root.hidden, true, "still finished: no crossing, no second card");
  finish.onApproved(false, true);
  finish.onApproved(true, true);
  assert.equal(root.hidden, false, "finished again, so said again");
  finish.onApproved(false, true);
  assert.equal(root.hidden, true, "a box came unticked under the card");
});

const REVIEWERS = { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" } as const;
const DIGESTING = { holder: "agent", mode: "digesting", at: "2025-01-01T00:01:00.000Z" } as const;
const WORKING = { holder: "agent", mode: "working", at: "2025-01-01T00:01:00.000Z" } as const;

test("the last tick on the agent's turn says nothing, whichever phase it is in", (t) => {
  for (const turn of [DIGESTING, WORKING]) {
    const { finish, log, side, root } = wired(t, turn);
    finish.attach(side);
    finish.onApproved(false, true);

    finish.onApproved(true, true);

    assert.equal(root.hidden, true, `no card while the agent is ${turn.mode}`);
    assert.ok(!log.includes("expand"), "the rail is left as it was");
  }
});

test("the turn coming back is not a tick: only the reviewer's own last approval opens the card", (t) => {
  const { finish, side, root } = wired(t, DIGESTING);
  finish.attach(side);
  finish.onApproved(false, true);
  finish.onApproved(true, true);

  finish.setTurn(REVIEWERS);
  assert.equal(root.hidden, true, "the agent answering in words changes no file");

  finish.onApproved(true, true);
  assert.equal(root.hidden, true, "still finished: no crossing");
  finish.onApproved(false, true);
  finish.onApproved(true, true);
  assert.equal(root.hidden, false, "the reviewer approved the last file on their own turn");
});

test("the turn arriving over the wire is heard before the last tick", (t) => {
  const { finish, side, root } = wired(t);
  finish.attach(side);
  finish.setTurn(WORKING);
  finish.onApproved(false, true);

  finish.onApproved(true, true);

  assert.equal(root.hidden, true);
});

test("a card already up goes down when the turn passes to the agent", (t) => {
  const { finish, side, root } = wired(t);
  finish.attach(side);
  finish.onApproved(false, true);
  finish.onApproved(true, true);
  assert.equal(root.hidden, false);

  finish.setTurn(DIGESTING);

  assert.equal(root.hidden, true);
});

test("a crossing the reviewer did not tick opens nothing, even on their turn", (t) => {
  const { finish, log, side, root } = wired(t);
  finish.attach(side);
  finish.onApproved(false, false);

  // A new round drawn with the rest carried over, or another tab's ticks arriving.
  finish.onApproved(true, false);

  assert.equal(root.hidden, true, "the reviewer approved nothing on this page");
  assert.ok(!log.includes("expand"), "the rail is left as it was");
  assert.equal(log.at(-1), "note:true", "the panel still knows the review is approved");

  finish.onApproved(true, true);
  assert.equal(root.hidden, true, "already approved: a later tick is no crossing");
});

test("a redraw that undoes the finish moves the baseline the next tick is read against", (t) => {
  const { finish, side, root } = wired(t);
  finish.attach(side);
  finish.onApproved(true, false);

  finish.onApproved(false, false);
  assert.equal(root.hidden, true);
  finish.onApproved(true, true);

  assert.equal(root.hidden, false, "the reviewer's own tick finished the new round");
});

test("a redraw that undoes the finish takes the card down", (t) => {
  const { finish, side, root } = wired(t);
  finish.attach(side);
  finish.onApproved(false, false);
  finish.onApproved(true, true);
  assert.equal(root.hidden, false);

  finish.onApproved(false, false);

  assert.equal(root.hidden, true);
});
