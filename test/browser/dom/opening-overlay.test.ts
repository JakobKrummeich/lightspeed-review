import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountOpening } from "../../../src/browser/dom/opening-overlay.ts";
import type { Stillness } from "../../../src/browser/dom/stillness.ts";
import { SKY_TIMES, type SkyChapter } from "../../../src/browser/starfield.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

/** Listeners removed by identity, so a leak shows as a second close. */
class FakeDocument {
  activeElement: FakeNode | null = null;
  /** The page behind the room, and the room's root among it. */
  body: { children: FakeNode[] } = { children: [] };
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
  /** The review behind the room. */
  behind: FakeNode;
  /** A sibling something else already made inert. */
  away: FakeNode & { inert?: boolean };
  opens: number;
  closes: number;
}

const MOVING: Stillness = { reducedMotion: false, forcedColors: false };

interface Room {
  held?: FakeNode;
  chapters?: SkyChapter[];
  still?: Stillness;
}

function mounted(t: TestContext, intents: string[], room: Room = {}): Mounted {
  const { held, chapters = [], still = MOVING } = room;
  const window = installFakeElements((undo) => t.after(undo)) as unknown as Record<string, number>;
  window.innerWidth = 1440;
  window.innerHeight = 900;
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
  const behind = new FakeNode("main", 'id="lsr-review"');
  const away: FakeNode & { inert?: boolean } = new FakeNode("div", 'id="lsr-done-popup"');
  away.inert = true;
  page.body.children = [behind, root, away];
  const state: Mounted = { root, page, behind, away, opens: 0, closes: 0 };
  mountOpening({
    root: asPanelRoot(root),
    intents,
    chapters,
    stillness: () => still,
    onOpen: () => (state.opens += 1),
    onClose: () => (state.closes += 1),
  });
  return state;
}

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

test("the last press jumps, the flash covers the swap, and the room goes as it lands", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one"]);
  const field = room(state.root);

  press(state.root, 0);
  press(state.root, 1);

  assert.equal(field.dataset.jump, "true", "the jump replaces the bloom's flood");
  assert.equal(field.dataset.bloom, "false", "the flash comes at the end of the jump");
  t.mock.timers.tick(SKY_TIMES.flashAtMs);
  assert.equal(field.dataset.bloom, "true");
  assert.notEqual(state.root.innerHTML, "", "the room is still up under the flash");
  assert.equal(state.closes, 0);

  t.mock.timers.tick(SKY_TIMES.jumpMs - SKY_TIMES.flashAtMs);

  assert.equal(state.root.innerHTML, "");
  assert.equal(state.closes, 1);
});

test("a reviewer who asked for less motion, or forced colours, lands at once: no jump", (t) => {
  for (const still of [
    { reducedMotion: true, forcedColors: false },
    { reducedMotion: false, forcedColors: true },
  ]) {
    const state = mounted(t, ["one"], { still });

    press(state.root, 0);
    press(state.root, 1);

    assert.equal(state.root.innerHTML, "", JSON.stringify(still));
    assert.equal(state.closes, 1);
  }
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

  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(state.closes, 1, "one way out, however many times it was pressed");
});

test("Esc leaves at once and without the flash: it is a way out, not a reward", (t) => {
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
  t.mock.timers.tick(SKY_TIMES.jumpMs);

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
  const state = mounted(t, ["one"], { held });

  state.page.press("Escape");

  assert.equal(held.focused, true);
});

test("nothing to open is nothing shown: no stack, no listener, nothing reported", (t) => {
  const state = mounted(t, []);

  assert.equal(state.root.innerHTML, "");
  assert.equal(state.page.keydownCount(), 0);
  assert.deepEqual([state.opens, state.closes], [0, 0]);
});

const CHAPTERS: SkyChapter[] = [
  { name: "Session state", files: [{ path: "src/state.ts", lines: 40 }] },
  { name: "Docs", files: [{ path: "README.md", lines: 2 }] },
];

function skySheet(root: FakeNode): FakeNode {
  const sheet = root.querySelectorAll(".lsr-opening-sheet").at(-1);
  assert.ok(sheet?.dataset.sky === "true", "the last sheet is the sky");
  return sheet;
}

function names(root: FakeNode): FakeNode {
  const layer = root.querySelector(".lsr-sky-names");
  assert.ok(layer, "the room has a layer for the names");
  return layer;
}

test("the constellation sheet comes after every reason, and the files gather as it opens", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root } = mounted(t, ["one", "two"], { chapters: CHAPTERS });
  const field = room(root);

  press(root, 0);
  press(root, 1);
  assert.equal(field.dataset.sky, "false", "no gathering while a reason is read");

  press(root, 2);

  assert.deepEqual(places(root), ["gone", "gone", "gone", "top"]);
  assert.equal(field.dataset.sky, "true");
});

test("the names come once the figures have formed, and the button 1.5 s after them", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root } = mounted(t, ["one"], { chapters: CHAPTERS });
  press(root, 0);
  press(root, 1);
  const sky = skySheet(root);
  const button = sky.querySelector(".lsr-opening-press");

  assert.equal(names(root).dataset.on, "false");
  assert.equal(button?.dataset.held, "true");
  assert.equal(sky.focused, true, "the sheet holds the caret while its button cannot");

  t.mock.timers.tick(SKY_TIMES.namesAtMs);
  assert.equal(names(root).dataset.on, "true");
  assert.equal(button?.dataset.held, "true", "the chapters are looked at first");

  t.mock.timers.tick(SKY_TIMES.heldAfterNamesMs - 1);
  assert.equal(button?.dataset.held, "true");
  t.mock.timers.tick(1);
  assert.equal(button?.dataset.held, "false");
  assert.equal(button?.focused, true);
});

test("no caret move scrolls the room: the sky stays centred under a tall reason", (t) => {
  // The room is full-bleed and fixed; a focus() that scrolls it drags the sky, the names and
  // the flash off centre. Every sheet, the held sky sheet and the revealed button included.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { root } = mounted(t, ["one", "two"], { chapters: CHAPTERS });
  press(root, 0);
  press(root, 1);
  press(root, 2);
  t.mock.timers.tick(SKY_TIMES.namesAtMs + SKY_TIMES.heldAfterNamesMs);

  const moved = [...root.querySelectorAll(".lsr-opening-sheet"), ...presses(root)].flatMap(
    (node) => node.focusCalls,
  );
  assert.ok(moved.length >= 5, "every sheet and the revealed button took the caret");
  for (const options of moved) assert.deepEqual(options, { preventScroll: true });
});

test("the names are laid in from the layout, one per chapter it could name", (t) => {
  const { root } = mounted(t, ["one"], { chapters: CHAPTERS });

  assert.equal(names(root).querySelectorAll(".lsr-sky-name").length, 2);
});

test("still, the sky is formed and named at once; the button still waits its 1.5 s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const still = { reducedMotion: true, forcedColors: false };
  const { root } = mounted(t, ["one"], { chapters: CHAPTERS, still });
  press(root, 0);
  press(root, 1);
  const button = skySheet(root).querySelector(".lsr-opening-press");

  t.mock.timers.tick(0);
  assert.equal(names(root).dataset.on, "true");
  t.mock.timers.tick(SKY_TIMES.heldAfterNamesMs);
  assert.equal(button?.dataset.held, "false");
});

test("a button on a sheet already gone answers nothing, even holding the caret", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one"], { chapters: CHAPTERS });
  press(state.root, 0);
  press(state.root, 1);

  press(state.root, 1);
  press(state.root, 0);

  assert.deepEqual(places(state.root), ["gone", "gone", "top"]);
  assert.equal(state.closes, 0);
});

test("the sky's button jumps into the review", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one"], { chapters: CHAPTERS });
  press(state.root, 0);
  press(state.root, 1);
  t.mock.timers.tick(SKY_TIMES.namesAtMs + SKY_TIMES.heldAfterNamesMs);
  const field = room(state.root);

  press(state.root, 2);
  assert.equal(field.dataset.jump, "true");
  assert.equal(names(state.root).dataset.on, "false", "the names go as the stars leave");

  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(state.root.innerHTML, "");
  assert.equal(state.closes, 1);
});

test("Esc leaves the sky before its button shows, and nothing it started runs on", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one"], { chapters: CHAPTERS });
  press(state.root, 0);
  press(state.root, 1);
  const button = skySheet(state.root).querySelector(".lsr-opening-press");

  state.page.press("Escape");
  t.mock.timers.tick(SKY_TIMES.namesAtMs + SKY_TIMES.heldAfterNamesMs);

  assert.equal(state.root.innerHTML, "");
  assert.equal(state.closes, 1);
  assert.equal(button?.dataset.held, "true", "the held button was never revealed");
});

test("the page behind the room is inert while it is up, so Tab cannot wander into it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one"], { chapters: CHAPTERS });
  const behind = state.behind as FakeNode & { inert?: boolean };

  assert.equal(behind.inert, true, "the review is out of reach while the room is up");
  assert.equal((state.root as FakeNode & { inert?: boolean }).inert, undefined, "the room is not");

  press(state.root, 0);
  press(state.root, 1);
  t.mock.timers.tick(SKY_TIMES.namesAtMs + SKY_TIMES.heldAfterNamesMs);
  press(state.root, 2);
  assert.equal(behind.inert, true, "still out of reach mid-jump");
  t.mock.timers.tick(SKY_TIMES.jumpMs);

  assert.equal(behind.inert, false, "the landing hands the page back");
  assert.equal(state.away.inert, true, "what something else made inert stays so");
});

test("Esc hands the page back too, before the caret goes home", (t) => {
  const held = new FakeNode("button");
  const state = mounted(t, ["one", "two"], { held });
  const behind = state.behind as FakeNode & { inert?: boolean };
  let inertAtFocus: boolean | undefined;
  const focus = held.focus.bind(held);
  held.focus = (options) => {
    inertAtFocus = behind.inert;
    focus(options);
  };

  state.page.press("Escape");

  assert.equal(behind.inert, false);
  assert.equal(inertAtFocus, false, "an inert page cannot take the caret back");
});

test("a strike still lit when the room closes is put out with it, not after", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = mounted(t, ["one", "two"]);
  const field = room(state.root);

  press(state.root, 0);
  state.page.press("Escape");
  t.mock.timers.tick(160);

  // The room is gone; a timer left behind would still be writing to it.
  assert.equal(field.dataset.flare, "true", "nothing the room started runs after it");
});

test("only the sheet on top can be reached: the invisible ones are inert, not just faded", (t) => {
  const { root } = mounted(t, ["one", "two"]);
  const reachable = (): (boolean | undefined)[] =>
    root
      .querySelectorAll(".lsr-opening-sheet")
      .map((sheet) => !(sheet as FakeNode & { inert?: boolean }).inert);

  assert.deepEqual(reachable(), [true, false, false]);
  press(root, 0);
  assert.deepEqual(reachable(), [false, true, false], "a peeled sheet's button is out of Tab");
});
