import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { paintSky, type SkyPainter } from "../../../src/browser/dom/starfield-canvas.ts";
import { layoutSky, type SkyChapter } from "../../../src/browser/starfield.ts";

const VIEW = { width: 1200, height: 800 };

/** Every call a 2D context receives, by name: the painter's cost is its calls. */
class FakeContext {
  readonly calls: string[] = [];

  constructor() {
    return new Proxy(this, {
      get: (target, name) => {
        if (Reflect.has(target, name)) return Reflect.get(target, name);
        if (name === "createRadialGradient") return () => ({ addColorStop: () => undefined });
        return () => {
          target.calls.push(String(name));
        };
      },
      set: (target, name, value) => {
        target.calls.push(`${String(name)}=${String(value)}`);
        return true;
      },
    });
  }

  count(name: string): number {
    return this.calls.filter((call) => call === name).length;
  }

  /** Every value `property` was set to, in order. */
  sets(property: string): string[] {
    return this.calls
      .filter((call) => call.startsWith(`${property}=`))
      .map((call) => call.slice(property.length + 1));
  }

  clear(): void {
    this.calls.length = 0;
  }
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly context: FakeContext | null;

  constructor(context: FakeContext | null) {
    this.context = context;
  }

  getContext(): FakeContext | null {
    return this.context;
  }

  after(): void {}
}

/** Watches what the scheme toggle writes; `connected` says whether anyone still listens. */
class FakeObserver {
  static made: FakeObserver[] = [];
  connected = false;
  readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
    FakeObserver.made.push(this);
  }

  observe(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }
}

/** A queue of frame callbacks the test runs by hand, so a leftover frame is visible. */
function fakePage(t: TestContext, scheme = "dark") {
  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    window: globals.window,
    getComputedStyle: globals.getComputedStyle,
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
    MutationObserver: globals.MutationObserver,
  };
  FakeObserver.made = [];
  globals.MutationObserver = FakeObserver;
  const root = { dataset: { colorScheme: scheme } };
  const shown = { inks: 0 };
  const frames = new Map<number, (now: number) => void>();
  let next = 1;
  globals.document = {
    documentElement: root,
    createElement: (tag: string) =>
      tag === "canvas" ? new FakeCanvas(new FakeContext()) : { style: {}, remove: () => undefined },
  };
  const window = { devicePixelRatio: 2 };
  globals.window = window;
  globals.getComputedStyle = () => {
    shown.inks += 1;
    return { color: "oklch(0.72 0.12 262)" };
  };
  globals.requestAnimationFrame = (callback: (now: number) => void) => {
    frames.set(next, callback);
    return next++;
  };
  globals.cancelAnimationFrame = (id: number) => frames.delete(id);
  t.after(() => Object.assign(globals, before));
  return {
    window,
    shown,
    /** The toggle writes the effective scheme; every observer still connected hears it. */
    flip(next: string): void {
      root.dataset.colorScheme = next;
      for (const observer of FakeObserver.made) if (observer.connected) observer.changed();
    },
    watching: () => FakeObserver.made.filter((observer) => observer.connected).length,
    pending: () => frames.size,
    /** Runs every queued frame once, at `now`. */
    run(now: number): void {
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback(now);
    },
  };
}

function chapters(sizes: number[]): SkyChapter[] {
  return sizes.map((count, chapter) => ({
    name: `Chapter ${chapter}`,
    files: Array.from({ length: count }, (_unused, index) => ({
      path: `c${chapter}/f${index}`,
      lines: index * 7 + 1,
    })),
  }));
}

function mount(context: FakeContext | null, still = false, sizes = [5, 4, 5]) {
  const canvas = new FakeCanvas(context);
  const sky = layoutSky(chapters(sizes), VIEW);
  const painter = paintSky(canvas as unknown as HTMLCanvasElement, sky, VIEW, still);
  return { canvas, sky, painter };
}

test("no 2D context, no painter: the room goes on without its stars", (t) => {
  const page = fakePage(t);

  assert.equal(mount(null).painter, undefined);
  assert.equal(page.pending(), 0);
});

test("the canvas is sized in device pixels for the whole view", (t) => {
  fakePage(t);
  const { canvas } = mount(new FakeContext());

  assert.deepEqual([canvas.width, canvas.height], [2400, 1600]);
});

test("each frame is one sprite per star and, once formed, one path for every figure", (t) => {
  const page = fakePage(t);
  const context = new FakeContext();
  const { sky, painter } = mount(context);
  const now = performance.now();

  page.run(now);
  assert.equal(context.count("drawImage"), sky.stars.length);
  assert.equal(context.count("stroke"), 0, "no figure lines before the files gather");

  painter?.gather();
  context.clear();
  page.run(now + 5000);
  assert.equal(context.count("drawImage"), sky.stars.length);
  assert.equal(context.count("stroke"), 1, "every figure in one stroke");
  assert.equal(page.pending(), 1, "the sky twinkles on while the sheet is up");
  painter?.stop();
});

test("the jump strokes at most three batches a frame, then lets go of the frame loop", (t) => {
  const page = fakePage(t, "light");
  const context = new FakeContext();
  const { painter } = mount(context, false, [300, 300]);
  const start = performance.now();
  page.run(start);

  painter?.jump();
  for (let ms = 16; ms < 1000; ms += 16) {
    context.clear();
    page.run(start + ms);
    assert.ok(context.count("stroke") <= 3, `${context.count("stroke")} strokes at ${ms}ms`);
    assert.equal(context.count("drawImage"), 0, "no sprites once the jump is on");
  }
  page.run(start + 5000);

  assert.equal(page.pending(), 0, "no animation frame remains after landing");
});

test("stopping takes the pending frame with it", (t) => {
  const page = fakePage(t);
  const { painter } = mount(new FakeContext());
  assert.equal(page.pending(), 1);

  painter?.stop();

  assert.equal(page.pending(), 0);
  painter?.gather();
  assert.equal(page.pending(), 0, "a stopped painter asks for nothing more");
});

test("still: every state drawn once, formed at once, and never a frame loop", (t) => {
  const page = fakePage(t);
  const context = new FakeContext();
  const { sky, painter } = mount(context, true);

  assert.equal(page.pending(), 0);
  assert.equal(context.count("drawImage"), sky.stars.length, "the scattered field, drawn once");

  context.clear();
  painter?.gather();
  assert.equal(context.count("stroke"), 1, "formed at once, figures and all");
  assert.equal(context.count("drawImage"), sky.stars.length);

  context.clear();
  painter?.jump();
  assert.equal(context.calls.length, 0, "no jump for a reviewer who asked for stillness");
  assert.equal(page.pending(), 0);
});

/** Runs a whole jump and returns every line width it stroked with. */
function jumpWidths(page: ReturnType<typeof fakePage>, context: FakeContext, painter?: SkyPainter) {
  const start = performance.now();
  page.run(start);
  painter?.jump();
  context.clear();
  for (let ms = 16; ms < 1100; ms += 16) page.run(start + ms);
  return new Set(context.sets("lineWidth"));
}

for (const [scheme, widths] of [
  ["dark", ["0.8", "1.5", "2.3"]],
  ["light", ["1", "1.8", "2.8"]],
] as const) {
  test(`the ${scheme} jump strokes its three batches in its own weights`, (t) => {
    const page = fakePage(t, scheme);
    const context = new FakeContext();
    const { painter } = mount(context, false, [300, 300]);

    const stroked = jumpWidths(page, context, painter);

    assert.deepEqual([...stroked].sort(), [...widths].sort());
    assert.deepEqual(new Set(context.sets("lineCap")), new Set(["round"]));
  });
}

test("a scheme flip reads the inks again: the jump after it is drawn in the new scheme", (t) => {
  const page = fakePage(t, "dark");
  const context = new FakeContext();
  const { painter } = mount(context, false, [300, 300]);
  const read = page.shown.inks;

  page.flip("light");

  assert.ok(page.shown.inks > read, "the tokens were resolved again");
  assert.ok(jumpWidths(page, context, painter).has("2.8"), "ink on paper, not a night sky");
});

test("a stopped painter stops watching the scheme, and a late flip draws nothing", (t) => {
  const page = fakePage(t);
  const context = new FakeContext();
  const { painter } = mount(context, true);
  assert.equal(page.watching(), 1);

  painter?.stop();
  context.clear();
  page.flip("light");

  assert.equal(page.watching(), 0);
  assert.equal(context.calls.length, 0);
});

test("a resize sizes the canvas again for the new view and its pixels, and draws the new sky", (t) => {
  const page = fakePage(t);
  const context = new FakeContext();
  const { canvas, painter } = mount(context);
  const smaller = { width: 700, height: 600 };
  const sky = layoutSky(chapters([2, 3]), smaller);

  page.window.devicePixelRatio = 3;
  painter?.resize(sky, smaller);
  context.clear();
  page.run(performance.now());

  assert.deepEqual([canvas.width, canvas.height], [2100, 1800], "the new view, at 3×");
  assert.equal(context.count("drawImage"), sky.stars.length, "the new layout's stars");
  assert.equal(page.pending(), 1, "the loop carries on");
  painter?.stop();
});

test("a resize mid-jump is ignored: the stars rush on from where they stood", (t) => {
  const page = fakePage(t);
  const { canvas, painter } = mount(new FakeContext());
  page.run(performance.now());
  painter?.jump();

  painter?.resize(layoutSky(chapters([1]), { width: 300, height: 300 }), {
    width: 300,
    height: 300,
  });

  assert.deepEqual([canvas.width, canvas.height], [2400, 1600]);
  painter?.stop();
});

test("still, a resize redraws at once, formed if the files had gathered", (t) => {
  const page = fakePage(t);
  const context = new FakeContext();
  const { painter } = mount(context, true);
  painter?.gather();
  const view = { width: 800, height: 500 };
  const sky = layoutSky(chapters([4, 4]), view);

  context.clear();
  painter?.resize(sky, view);

  assert.equal(context.count("drawImage"), sky.stars.length);
  assert.equal(context.count("stroke"), 1, "still formed, figures and all");
  assert.equal(page.pending(), 0, "and still no loop");
});

for (const [scheme, alpha] of [
  ["dark", 0.7],
  ["light", 0.55],
] as const) {
  test(`the ${scheme} figures are drawn at their own weight once formed`, (t) => {
    const page = fakePage(t, scheme);
    const context = new FakeContext();
    const { painter } = mount(context);
    const now = performance.now();
    painter?.gather();

    context.clear();
    page.run(now + 5000);

    assert.ok(context.sets("globalAlpha").includes(String(alpha)), `lines at ${alpha}`);
    painter?.stop();
  });
}

test("a window that does not say its pixel density is drawn at 1×", (t) => {
  const page = fakePage(t);
  delete (page.window as { devicePixelRatio?: number }).devicePixelRatio;

  const { canvas } = mount(new FakeContext());

  assert.deepEqual([canvas.width, canvas.height], [1200, 800]);
});

test("a stopped painter lays nothing out again on a late resize", (t) => {
  const page = fakePage(t);
  const context = new FakeContext();
  const { canvas, painter } = mount(context, true);
  painter?.stop();
  context.clear();

  painter?.resize(layoutSky(chapters([1]), { width: 300, height: 300 }), {
    width: 300,
    height: 300,
  });

  assert.deepEqual([canvas.width, canvas.height], [2400, 1600]);
  assert.equal(context.calls.length, 0);
  assert.equal(page.pending(), 0);
});

test("no context for the star sprite: the stars are still placed, drawn from a blank sprite", (t) => {
  const page = fakePage(t);
  const globals = globalThis as { document: { createElement: (tag: string) => unknown } };
  globals.document.createElement = (tag: string) =>
    tag === "canvas" ? new FakeCanvas(null) : { style: {}, remove: () => undefined };
  const context = new FakeContext();
  const { sky } = mount(context);

  page.run(performance.now());

  assert.equal(context.count("drawImage"), sky.stars.length);
});
