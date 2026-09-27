import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { arrivals, playJump } from "../../../src/browser/dom/jump-overlay.ts";
import { mountOpening } from "../../../src/browser/dom/opening-overlay.ts";
import type { SkyPainter } from "../../../src/browser/dom/starfield-canvas.ts";
import type { Stillness } from "../../../src/browser/dom/stillness.ts";
import { SKY_TIMES, type Sky } from "../../../src/browser/starfield.ts";
import { asPanelRoot, FakeNode, installFakeElements } from "./fake-panel-dom.ts";

type Inert = FakeNode & { inert?: boolean };

interface Key {
  key: string;
  stopped: boolean;
  stopPropagation(): void;
}

/** Capture listeners first, as the browser runs them; one stopped key reaches no bubble listener. */
class FakeDocument {
  activeElement: FakeNode | null = null;
  body: { children: FakeNode[] } = { children: [] };
  private listeners: { type: string; handler: (event: unknown) => void; capture: boolean }[] = [];

  addEventListener(type: string, handler: (event: unknown) => void, capture = false): void {
    this.listeners.push({ type, handler, capture: capture === true });
  }

  removeEventListener(type: string, handler: (event: unknown) => void, capture = false): void {
    this.listeners = this.listeners.filter(
      (known) =>
        known.type !== type || known.handler !== handler || known.capture !== (capture === true),
    );
  }

  press(key: string): Key {
    const event: Key = {
      key,
      stopped: false,
      stopPropagation() {
        this.stopped = true;
      },
    };
    const keydown = this.listeners.filter((known) => known.type === "keydown");
    for (const phase of [true, false]) {
      for (const known of keydown.filter((one) => one.capture === phase)) {
        if (event.stopped) return event;
        known.handler(event);
      }
    }
    return event;
  }

  /** The whole page, the way the browser searches it: every body child and all beneath. */
  querySelectorAll(selector: string): FakeNode[] {
    return this.body.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  keydownCount(): number {
    return this.listeners.filter((known) => known.type === "keydown").length;
  }
}

/** Records what the jump asks of its painter: the sky it was handed and every call after. */
function fakePaint() {
  const calls: string[] = [];
  const skies: Sky[] = [];
  const paint = (_canvas: HTMLCanvasElement, sky: Sky, _view: unknown, still: boolean) => {
    skies.push(sky);
    calls.push(`paint still=${still}`);
    const painter: SkyPainter = {
      gather: () => calls.push("gather"),
      jump: () => calls.push("jump"),
      stop: () => calls.push("stop"),
      resize: () => calls.push("resize"),
    };
    return painter;
  };
  return { calls, skies, paint };
}

const MOVING: Stillness = { reducedMotion: false, forcedColors: false };

interface Page {
  page: FakeDocument;
  root: FakeNode;
  behind: Inert;
}

function page(t: TestContext): Page {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const window = installFakeElements((undo) => t.after(undo)) as unknown as Record<string, number>;
  window.innerWidth = 1440;
  window.innerHeight = 900;
  const doc = new FakeDocument();
  const globals = globalThis as Record<string, unknown>;
  const before = globals.document;
  globals.document = doc;
  t.after(() => {
    globals.document = before;
  });
  const root = new FakeNode("div", 'id="lsr-opening"');
  const behind: Inert = new FakeNode("main", 'id="lsr-review"');
  doc.body.children = [behind, root];
  return { page: doc, root, behind };
}

function jumped(t: TestContext, still: Stillness = MOVING) {
  const { page: doc, root, behind } = page(t);
  const painter = fakePaint();
  const state = { root, page: doc, behind, painter, lands: 0 };
  playJump({
    root: asPanelRoot(root),
    still,
    land: () => (state.lands += 1),
    paint: painter.paint,
  });
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

test("the stars are all deep ones, jumping from the first frame, and stop on the landing", (t) => {
  const state = jumped(t);

  assert.deepEqual(state.painter.calls, ["paint still=false", "jump"]);
  assert.equal(state.painter.skies[0]?.stars.length, 0, "no files of its own");

  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.deepEqual(state.painter.calls, ["paint still=false", "jump", "stop"]);
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
  assert.ok(state.painter.calls.includes("stop"), "no frame outlives the room");

  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(state.lands, 1, "one landing, however it came");
  assert.equal(state.page.keydownCount(), 0);
});

test("an ordinary key is not a way out, and reaches nothing behind the room", (t) => {
  const state = jumped(t);
  let heard = 0;
  state.page.addEventListener("keydown", () => (heard += 1));

  const key = state.page.press("a");

  assert.equal(state.lands, 0);
  assert.equal(key.stopped, true);
  assert.equal(heard, 0, "the page's own keys wait for the landing");
});

test("Esc during the jump is the jump's alone: a popup behind it never hears it", (t) => {
  const state = jumped(t);
  let popupClosed = 0;
  // The done card and the round card listen on the document, in the bubble phase.
  state.page.addEventListener("keydown", (event) => {
    if ((event as Key).key === "Escape") popupClosed += 1;
  });

  state.page.press("Escape");

  assert.equal(state.lands, 1);
  assert.equal(popupClosed, 0);
  state.page.press("Escape");
  assert.equal(popupClosed, 1, "after the landing the page has its keys back");
});

test("the page is inert while the jump plays and handed back, caret and all, on landing", (t) => {
  const { page: doc, root, behind } = page(t);
  const writing = new FakeNode("textarea");
  doc.activeElement = writing;
  let whenLanded: { inert?: boolean; caret: boolean } | undefined;
  playJump({
    root: asPanelRoot(root),
    still: MOVING,
    land: () => {
      whenLanded = { inert: behind.inert, caret: writing.focused };
    },
    paint: fakePaint().paint,
  });

  assert.equal(behind.inert, true, "Tab and typing cannot reach the review mid-jump");
  t.mock.timers.tick(SKY_TIMES.jumpMs);

  assert.deepEqual(whenLanded, { inert: false, caret: true }, "handed back before the replay");
  assert.deepEqual(writing.focusCalls, [{ preventScroll: true }]);
});

/** The page with two thread reply boxes, the second holding the caret, as a round starts to arrive. */
function replyingThenJump(t: TestContext, boxes: string) {
  const { page: doc, root, behind } = page(t);
  behind.innerHTML = boxes;
  const writing = behind.querySelectorAll("textarea")[1];
  assert.ok(writing);
  doc.activeElement = writing;
  let lands = 0;
  playJump({
    root: asPanelRoot(root),
    still: MOVING,
    land: () => (lands += 1),
    paint: fakePaint().paint,
  });
  // The round is drawn under the room: the panel replaces every reply box.
  behind.innerHTML = boxes;
  const [other, again] = behind.querySelectorAll("textarea");
  return { doc, writing, other, again, lands: () => lands };
}

test("a reply box the round redrew mid-jump gets the caret back: its twin, found by name", (t) => {
  const box = (thread: string) =>
    `<textarea class="lsr-thread-reply-box" data-thread="${thread}"></textarea>`;
  const state = replyingThenJump(t, box("t0") + box("t1"));
  assert.equal(state.writing.isConnected, false, "the box the caret was in is gone");

  t.mock.timers.tick(SKY_TIMES.jumpMs);

  assert.equal(state.lands(), 1);
  assert.equal(state.doc.activeElement, state.again, "the same thread's new box");
  assert.deepEqual(state.again?.focusCalls, [{ preventScroll: true }]);
  assert.equal(state.other?.focusCalls.length, 0, "not the other thread's");
});

test("a gone element with nothing that names it is not guessed at", (t) => {
  const state = replyingThenJump(t, "<textarea></textarea><textarea></textarea>");

  t.mock.timers.tick(SKY_TIMES.jumpMs);

  assert.equal(state.lands(), 1);
  assert.equal(state.other?.focusCalls.length, 0);
  assert.equal(state.again?.focusCalls.length, 0);
  assert.equal(state.writing.focusCalls.length, 0, "nor focused where nobody sees it");
});

test("no canvas to paint: the tunnel and the flash still carry the jump", (t) => {
  const { page: doc, root } = page(t);
  let lands = 0;
  let painted = 0;
  const bare = asPanelRoot(root);
  const write = Object.getOwnPropertyDescriptor(FakeNode.prototype, "innerHTML");
  // A room drawn without its canvas: the markup minus the one element the painter needs.
  Object.defineProperty(root, "innerHTML", {
    get: () => write?.get?.call(root) as string,
    set: (html: string) => write?.set?.call(root, html.replace(/<canvas[^>]*><\/canvas>/, "")),
  });
  playJump({
    root: bare,
    still: MOVING,
    land: () => (lands += 1),
    paint: () => {
      painted += 1;
      return undefined;
    },
  });

  assert.equal(painted, 0);
  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(lands, 1);
  assert.equal(doc.keydownCount(), 0);
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
    assert.equal(state.behind.inert, undefined, "nothing was held");
    assert.deepEqual(state.painter.calls, []);
  });
}

/** Another tab moved the review on while this one still sits in the opening. */
function openingThenJump(t: TestContext, still: Stillness = MOVING) {
  const { page: doc, root, behind } = page(t);
  const cover = new FakeNode("button");
  doc.activeElement = cover;
  const state = { page: doc, root, behind, cover, closes: 0, lands: 0 };
  mountOpening({
    root: asPanelRoot(root),
    intents: ["one"],
    chapters: [{ name: "Only", files: [{ path: "a.ts", lines: 3 }] }],
    stillness: () => still,
    onOpen: () => undefined,
    onClose: () => (state.closes += 1),
  });
  assert.equal(behind.inert, true, "the opening holds the page");
  playJump({
    root: asPanelRoot(root),
    still,
    land: () => (state.lands += 1),
    paint: fakePaint().paint,
  });
  return state;
}

test("a round arriving under the opening closes it properly before the jump takes the root", (t) => {
  const state = openingThenJump(t);

  assert.equal(state.closes, 1, "the opening left by its own way out");
  assert.ok(state.root.querySelector(".lsr-jump-overlay"), "the jump has the root");
  assert.equal(state.root.querySelector(".lsr-opening-overlay"), null);
  assert.equal(state.page.keydownCount(), 1, "only the jump listens");
  assert.equal(state.behind.inert, true, "held again, by the jump");

  t.mock.timers.tick(SKY_TIMES.namesAtMs + SKY_TIMES.heldAfterNamesMs + SKY_TIMES.jumpMs);
  assert.equal(state.lands, 1);
  assert.equal(state.page.keydownCount(), 0, "no orphan listener left behind");
  assert.equal(state.behind.inert, false);
});

test("the caret lands where the closed opening handed it back, not on its gone sheet", (t) => {
  const state = openingThenJump(t);
  assert.equal(state.page.activeElement, state.cover, "the opening's close put it back");
  const calls = state.cover.focusCalls.length;

  t.mock.timers.tick(SKY_TIMES.jumpMs);

  assert.equal(state.cover.focusCalls.length, calls + 1, "the landing hands it back there");
  assert.deepEqual(state.cover.focusCalls.at(-1), { preventScroll: true });
});

test("after that landing, Esc runs no orphaned close: the caret stays where it landed", (t) => {
  const state = openingThenJump(t);
  t.mock.timers.tick(SKY_TIMES.jumpMs);
  const caret = state.cover.focusCalls.length;

  state.page.press("Escape");

  assert.equal(state.closes, 1);
  assert.equal(state.cover.focusCalls.length, caret, "nothing moved the caret again");
});

test("still, a round arriving under the opening still closes it, then lands at once", (t) => {
  const state = openingThenJump(t, { reducedMotion: true, forcedColors: false });

  assert.equal(state.closes, 1);
  assert.equal(state.lands, 1);
  assert.equal(state.root.innerHTML, "");
  assert.equal(state.page.keydownCount(), 0);
  assert.equal(state.behind.inert, false);
});

test("a second round mid-jump lands the first before it takes off", (t) => {
  const state = jumped(t);

  playJump({
    root: asPanelRoot(state.root),
    still: MOVING,
    land: () => (state.lands += 10),
    paint: fakePaint().paint,
  });

  assert.equal(state.lands, 1, "the first landed");
  assert.equal(state.page.keydownCount(), 1);
  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(state.lands, 11);
  assert.equal(state.behind.inert, false);
});

test("the page's arrivals say a jump is in flight until it lands, so a reopen can wait", (t) => {
  const { root } = page(t);
  let asked = 0;
  const arrival = arrivals(asPanelRoot(root), () => {
    asked += 1;
    return MOVING;
  });
  let opened = 0;

  assert.equal(arrival.jumping(), false);
  arrival.jump();
  assert.equal(arrival.jumping(), true, "mid-jump: the landing will open the replay");
  arrival.onLanding(() => (opened += 1));
  assert.equal(opened, 0, "the replay waits for the landing");
  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(arrival.jumping(), false);
  assert.equal(opened, 1);

  arrival.jump();
  assert.equal(asked, 2, "stillness is asked per jump, not once");
  assert.equal(root.querySelector(".lsr-sky-canvas") !== null, true);
});

test("with no jump in flight, what follows a landing runs at once", (t) => {
  const { root } = page(t);
  const arrival = arrivals(asPanelRoot(root), () => MOVING);
  let opened = 0;

  arrival.onLanding(() => (opened += 1));

  assert.equal(opened, 1);
});

test("still, the arrival lands at once and what follows it runs at once", (t) => {
  const { root } = page(t);
  const arrival = arrivals(asPanelRoot(root), () => ({ reducedMotion: true, forcedColors: false }));
  let opened = 0;

  arrival.jump();
  arrival.onLanding(() => (opened += 1));

  assert.equal(arrival.jumping(), false);
  assert.equal(opened, 1);
  assert.equal(root.innerHTML, "");
});

test("a second arrival mid-jump keeps the page jumping until the second lands", (t) => {
  const { root } = page(t);
  const arrival = arrivals(asPanelRoot(root), () => MOVING);
  const opened: string[] = [];

  arrival.jump();
  arrival.onLanding(() => opened.push("first"));
  t.mock.timers.tick(SKY_TIMES.flashAtMs);
  arrival.jump();

  assert.equal(arrival.jumping(), true, "the first's landing does not end the second's flight");
  assert.equal(opened.length, 0, "the replay waits for the jump the page is still in");
  arrival.onLanding(() => opened.push("second"));
  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(arrival.jumping(), false);
  assert.deepEqual(opened, ["second"], "only the latest round's replay opens");
});

test("a painter that throws lands the jump at once and hands the page back", (t) => {
  const { page: doc, root, behind } = page(t);
  const errors = t.mock.method(console, "error", () => {});
  let lands = 0;

  playJump({
    root: asPanelRoot(root),
    still: MOVING,
    land: () => (lands += 1),
    paint: () => {
      throw new Error("no canvas today");
    },
  });

  assert.equal(lands, 1, "the round is not held back by its decoration");
  assert.equal(root.innerHTML, "");
  assert.equal(behind.inert, false, "the page is not left inert");
  assert.equal(doc.keydownCount(), 0);
  assert.equal(errors.mock.callCount(), 1, "said, not swallowed");

  // The root is free: the next room's claim evicts nothing that throws.
  playJump({
    root: asPanelRoot(root),
    still: MOVING,
    land: () => (lands += 1),
    paint: fakePaint().paint,
  });
  t.mock.timers.tick(SKY_TIMES.jumpMs);
  assert.equal(lands, 2);
});
