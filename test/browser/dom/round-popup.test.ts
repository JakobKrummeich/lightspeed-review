import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { FOLD_MS, mountRoundPopup } from "../../../src/browser/dom/round-popup.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
import type { DiffFile } from "../../../src/diff-extract.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

/** The page as far as the popup touches it: the Esc listener. */
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

function file(path: string): DiffFile {
  return {
    path,
    status: "modified",
    diff: `@@ -1 +1 @@\n-old\n+new ${path}`,
    insertions: 1,
    deletions: 1,
    oversized: false,
  };
}

/** A session standing on `round`, with one group of the paths given. */
function session(round: number, paths: string[]): SessionData {
  return {
    intents: [],
    commits: [],
    groups: [{ name: "API", rationale: "", files: paths.map(file) }],
    approved: [],
    approval: {},
    conversation: [],
    rounds: Array.from({ length: round + 1 }, (_unused, index) => ({
      index,
      at: `2025-01-0${index + 1}T00:00:00.000Z`,
    })),
    pending: [],
    status: "feedback",
  };
}

function mounted(t: TestContext): {
  root: FakeNode;
  page: FakeDocument;
  taken: SessionData[];
  dismissed: number[];
  offer(round: number, paths?: string[]): SessionData;
  clear(): void;
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
  const root = new FakeNode("div", 'id="lsr-round-popup" hidden');
  const taken: SessionData[] = [];
  const dismissed: number[] = [];
  const popup = mountRoundPopup({
    root: asPanelRoot(root),
    onTake: (fresh) => taken.push(fresh),
    onDismissed: () => dismissed.push(1),
  });
  return {
    root,
    page,
    taken,
    dismissed,
    offer: (round, paths = ["src/a.ts"]) => {
      const fresh = session(round, paths);
      popup.offer(fresh);
      return fresh;
    },
    clear: () => popup.clear(),
    click: (selector: string) => {
      const target = root.querySelector(selector);
      assert.ok(target, `${selector} is on screen`);
      root.dispatch("click", { target });
    },
  };
}

const folded = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, FOLD_MS + 30));

test("an arriving round is announced over the review, once", (t) => {
  const { root, offer } = mounted(t);

  offer(1);

  assert.equal(root.hidden, false);
  assert.match(root.innerHTML, /Round 2 is ready/);
  assert.match(root.innerHTML, /1 file</);
});

test("the card's own press takes the round that was offered", (t) => {
  const { root, offer, taken, click, page } = mounted(t);
  const fresh = offer(1);

  click(".lsr-round-take");

  assert.deepEqual(taken, [fresh]);
  assert.equal(root.hidden, true);
  assert.equal(root.innerHTML, "");
  assert.equal(page.keydownCount(), 0, "a closed card listens for nothing");
});

test("keep reading folds the card away and then says it is gone", async (t) => {
  const { root, offer, dismissed, taken, click } = mounted(t);
  offer(1);

  click(".lsr-round-stay");

  assert.equal(root.dataset.state, "folding", "the exit is visible before it is over");
  assert.deepEqual(dismissed, [], "not gone yet: the fold is still running");

  await folded();

  assert.equal(root.hidden, true);
  assert.deepEqual(dismissed, [1]);
  assert.deepEqual(taken, []);
});

test("Esc is keep reading for the keyboard", async (t) => {
  const { root, offer, dismissed, page } = mounted(t);
  offer(1);

  page.press("Escape");
  await folded();

  assert.equal(root.hidden, true);
  assert.deepEqual(dismissed, [1]);
});

test("a second Esc mid-fold does not say goodbye twice", async (t) => {
  const { offer, dismissed, page } = mounted(t);
  offer(1);

  page.press("Escape");
  page.press("Escape");
  await folded();

  assert.deepEqual(dismissed, [1]);
});

test("the same round is not announced again after the reviewer waved it away", async (t) => {
  const { root, offer, page } = mounted(t);
  offer(1);
  page.press("Escape");
  await folded();

  offer(1);

  assert.equal(root.hidden, true, "they already answered this question");
});

test("a newer round is fresh news, even over the last card's fold", async (t) => {
  const { root, offer, dismissed, click } = mounted(t);
  offer(1);
  click(".lsr-round-stay");

  offer(2, ["src/a.ts", "src/b.ts"]);

  assert.equal(root.hidden, false);
  assert.equal(root.dataset.state, undefined, "the fold was overtaken, not finished");
  assert.match(root.innerHTML, /Round 3 is ready/);

  await folded();

  assert.deepEqual(dismissed, [], "the overtaken fold's ending never fired");
});

test("a card still up hands over the newest copy of its round", (t) => {
  const { offer, taken, click } = mounted(t);
  offer(1);
  const newer = offer(1, ["src/a.ts", "src/b.ts"]);

  click(".lsr-round-take");

  assert.deepEqual(taken, [newer]);
});

test("a round that went on screen by another route takes the card with it", async (t) => {
  const { root, offer, dismissed, clear, click } = mounted(t);
  offer(1);
  click(".lsr-round-stay");

  clear();
  await folded();

  assert.equal(root.hidden, true);
  assert.deepEqual(dismissed, [], "nothing was dismissed: the round arrived");

  offer(2);

  assert.equal(root.hidden, false, "the next round is fresh news again");
});
