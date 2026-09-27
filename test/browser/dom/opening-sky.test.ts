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
