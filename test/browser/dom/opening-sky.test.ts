import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountOpeningSky } from "../../../src/browser/dom/opening-sky.ts";
import type { SkyPainter } from "../../../src/browser/dom/starfield-canvas.ts";
import type { Stillness } from "../../../src/browser/dom/stillness.ts";
import { renderOpening } from "../../../src/browser/opening-view.ts";
import {
  SKY_TIMES,
  type Sky,
  type SkyBox,
  type SkyChapter,
} from "../../../src/browser/starfield.ts";
import { asPanelRoot, FakeNode, installFakeElements, type FakeWindow } from "./fake-panel-dom.ts";

const MOVING: Stillness = { reducedMotion: false, forcedColors: false };
const STILL: Stillness = { reducedMotion: true, forcedColors: false };
const FORCED: Stillness = { reducedMotion: false, forcedColors: true };

const CHAPTERS: SkyChapter[] = [
  {
    name: "Session state",
    files: [
      { path: "a.ts", lines: 40 },
      { path: "b.ts", lines: 3 },
    ],
  },
  { name: "Docs", files: [{ path: "README.md", lines: 5 }] },
];

/** Every call the sky makes of its painter, and every sky and view it was handed. */
function fakePaint() {
  const calls: string[] = [];
  const views: SkyBox[] = [];
  const skies: Sky[] = [];
  const paint = (_canvas: HTMLCanvasElement, sky: Sky, view: SkyBox, still: boolean) => {
    calls.push(`paint still=${still}`);
    skies.push(sky);
    views.push(view);
    const painter: SkyPainter = {
      gather: () => calls.push("gather"),
      jump: () => calls.push("jump"),
      stop: () => calls.push("stop"),
      resize: (next, nextView) => {
        calls.push("resize");
        skies.push(next);
        views.push(nextView);
      },
    };
    return painter;
  };
  return { calls, views, skies, paint };
}

interface Room {
  field: FakeNode;
  window: FakeWindow & Record<string, number>;
}

/** The opening's own markup, so the sky finds its canvas and names layer where the page has them. */
function room(t: TestContext, bare = false): Room {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const window = installFakeElements((undo) => t.after(undo)) as FakeWindow &
    Record<string, number>;
  window.innerWidth = 1440;
  window.innerHeight = 900;
  if (bare) return { field: new FakeNode("div", 'class="lsr-opening-overlay"'), window };
  const root = new FakeNode("div");
  root.innerHTML = renderOpening(["one"], CHAPTERS);
  const field = root.querySelector(".lsr-opening-overlay");
  assert.ok(field);
  return { field, window };
}

function names(field: FakeNode): string {
  return field.querySelector(".lsr-sky-names")?.innerHTML ?? "";
}

test("the sky is painted over the whole window, laid out above the button's strip", (t) => {
  const { field } = room(t);
  const painter = fakePaint();

  mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);

  assert.deepEqual(painter.calls, ["paint still=false"]);
  assert.deepEqual(painter.views[0], { width: 1440, height: 900 });
  assert.deepEqual(painter.skies[0]?.box, { width: 1440, height: 772 });
  assert.match(names(field), /Session state/);
});

test("a resize lays the sky out again once the window settles, names and all", (t) => {
  const { field, window } = room(t);
  const painter = fakePaint();
  mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);
  const before = names(field);

  window.innerWidth = 700;
  window.innerHeight = 600;
  window.fire("resize");
  window.fire("resize");
  t.mock.timers.tick(149);
  assert.equal(painter.calls.includes("resize"), false, "a burst is waited out");
  window.fire("resize");
  t.mock.timers.tick(150);

  assert.deepEqual(painter.calls, ["paint still=false", "resize"], "once, for the whole burst");
  assert.deepEqual(painter.views.at(-1), { width: 700, height: 600 });
  assert.deepEqual(painter.skies.at(-1)?.box, { width: 700, height: 472 });
  assert.notEqual(names(field), before, "the names stand under the new layout");
});

/** Gives the room's canvas a 2D context that measures `perChar` px a character in any font. */
function measuring(t: TestContext, field: FakeNode, perChar: number): string[] {
  const fonts: string[] = [];
  const context = {
    font: "",
    measureText(text: string) {
      fonts.push(this.font);
      return { width: [...text].length * perChar };
    },
  };
  const canvas = field.querySelector(".lsr-sky-canvas") as FakeNode & Record<string, unknown>;
  canvas.getContext = () => context;
  const globals = globalThis as Record<string, unknown>;
  const before = globals.getComputedStyle;
  // Live, as the browser's is: a detached element's computed style reads empty.
  globals.getComputedStyle = (element: FakeNode) => {
    const attached = () => field.querySelector(".lsr-sky-title") === element;
    return {
      get fontStyle() {
        return attached() ? "normal" : "";
      },
      fontWeight: "700",
      fontSize: "14px",
      fontFamily: "system-ui",
    };
  };
  t.after(() => {
    globals.getComputedStyle = before;
  });
  return fonts;
}

test("names are measured on the sky's canvas, in the font a name is set in", (t) => {
  const { field, window } = room(t);
  const fonts = measuring(t, field, 20);
  const painter = fakePaint();

  mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);

  const docs = painter.skies[0]?.labels.find((label) => label.name === "Docs");
  assert.equal(docs?.width, 4 * 20 + 12, "measured, not guessed");
  const session = painter.skies[0]?.labels.find((label) => label.name === "Session state");
  assert.equal(session?.width, 240, "13 × 20 px is past the widest a name may be");
  assert.equal(session?.height, 56, "measured past the widest: two lines");
  assert.ok(
    fonts.every((font) => font === "normal 700 14px system-ui"),
    "the name's own font",
  );
  assert.doesNotMatch(names(field), /lsr-sky-title">M</, "the probe is gone");

  window.innerWidth = 700;
  window.fire("resize");
  t.mock.timers.tick(150);
  assert.equal(painter.skies.at(-1)?.labels[0]?.height, 56, "measured again on the relayout");
});

test("with no canvas context to measure in, names fall back to the estimate", (t) => {
  const { field } = room(t);
  const canvas = field.querySelector(".lsr-sky-canvas") as FakeNode & Record<string, unknown>;
  canvas.getContext = () => null;
  const painter = fakePaint();

  mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);

  const session = painter.skies[0]?.labels.find((label) => label.name === "Session state");
  assert.equal(session?.width, 13 * 9 + 12);
});

test("a new pixel density alone lays the sky out again, and the watch re-arms at it", (t) => {
  // Dragging the window to a screen of another density changes no size: no resize comes.
  const { field, window } = room(t);
  const painter = fakePaint();
  const sky = mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);
  assert.equal(
    window.mediaListeners("(resolution: 1dppx)"),
    1,
    "watching the density it opened on",
  );

  window.devicePixelRatio = 2;
  window.changeMedia("(resolution: 1dppx)");
  t.mock.timers.tick(150);
  assert.deepEqual(painter.calls, ["paint still=false", "resize"], "the canvas is sized again");
  assert.equal(window.mediaListeners("(resolution: 1dppx)"), 0, "the old density let go");
  assert.equal(window.mediaListeners("(resolution: 2dppx)"), 1, "re-armed at the new one");

  window.devicePixelRatio = 1;
  window.changeMedia("(resolution: 2dppx)");
  t.mock.timers.tick(150);
  assert.equal(painter.calls.filter((call) => call === "resize").length, 2, "and again back");

  sky.stop();
  assert.equal(
    window.queries.reduce((sum, one) => sum + one.listeners.length, 0),
    0,
    "stop leaves no density watch behind",
  );
});

test("from the jump on, and after the room closes, a resize changes nothing", (t) => {
  const { field, window } = room(t);
  const painter = fakePaint();
  const sky = mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);

  sky.leave(() => undefined);
  assert.equal(window.listening("resize"), 0, "the jump stops listening");
  sky.stop();
  window.fire("resize");
  t.mock.timers.tick(1000);

  assert.equal(painter.calls.includes("resize"), false);
});

test("closing mid-burst takes the pending relayout with it", (t) => {
  const { field, window } = room(t);
  const painter = fakePaint();
  const sky = mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);

  window.fire("resize");
  sky.stop();
  t.mock.timers.tick(1000);

  assert.equal(painter.calls.includes("resize"), false);
  assert.equal(window.listening("resize"), 0);
  assert.equal(painter.calls.at(-1), "stop");
});

test("moving: gather, names at their time, the way on after them, and the jump to land", (t) => {
  const { field } = room(t);
  const painter = fakePaint();
  const sky = mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);
  let revealed = 0;
  let landed = 0;

  sky.arrive(() => (revealed += 1));
  assert.equal(field.dataset.sky, "true");
  t.mock.timers.tick(SKY_TIMES.namesAtMs);
  assert.equal(field.querySelector(".lsr-sky-names")?.dataset.on, "true");
  t.mock.timers.tick(SKY_TIMES.heldAfterNamesMs);
  assert.equal(revealed, 1);

  sky.leave(() => (landed += 1));
  assert.equal(field.dataset.jump, "true");
  assert.equal(field.querySelector(".lsr-sky-names")?.dataset.on, "false");
  t.mock.timers.tick(SKY_TIMES.flashAtMs);
  assert.equal(field.dataset.bloom, "true");
  t.mock.timers.tick(SKY_TIMES.jumpMs - SKY_TIMES.flashAtMs);
  assert.equal(landed, 1);
  assert.deepEqual(painter.calls, ["paint still=false", "gather", "jump"]);
});

test("still: painted once, named at once, and the last press lands without a jump", (t) => {
  const { field } = room(t);
  const painter = fakePaint();
  const sky = mountOpeningSky(asPanelRoot(field), CHAPTERS, STILL, painter.paint);
  let landed = 0;

  sky.arrive(() => undefined);
  t.mock.timers.tick(0);
  assert.equal(field.querySelector(".lsr-sky-names")?.dataset.on, "true");
  sky.leave(() => (landed += 1));

  assert.equal(landed, 1);
  assert.equal(field.dataset.jump, "false");
  assert.deepEqual(painter.calls, ["paint still=true", "gather"]);
});

test("forced colours: no painter at all, the names alone, and no jump", (t) => {
  const { field } = room(t);
  const painter = fakePaint();
  const sky = mountOpeningSky(asPanelRoot(field), CHAPTERS, FORCED, painter.paint);
  let landed = 0;

  sky.arrive(() => undefined);
  sky.leave(() => (landed += 1));

  assert.deepEqual(painter.calls, []);
  assert.match(names(field), /Docs/);
  assert.equal(landed, 1);
});

test("a room without its canvas or names layer still keeps the sky's clock", (t) => {
  const { field, window } = room(t, true);
  const painter = fakePaint();
  const sky = mountOpeningSky(asPanelRoot(field), CHAPTERS, MOVING, painter.paint);
  let revealed = 0;
  let landed = 0;

  sky.arrive(() => (revealed += 1));
  window.fire("resize");
  t.mock.timers.tick(SKY_TIMES.namesAtMs + SKY_TIMES.heldAfterNamesMs);
  sky.leave(() => (landed += 1));
  t.mock.timers.tick(SKY_TIMES.jumpMs);

  assert.deepEqual(painter.calls, [], "nothing to paint on");
  assert.equal(revealed, 1);
  assert.equal(landed, 1);
});
