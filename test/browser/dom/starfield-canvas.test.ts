import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { paintSky } from "../../../src/browser/dom/starfield-canvas.ts";
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
      set: () => true,
    });
  }

  count(name: string): number {
    return this.calls.filter((call) => call === name).length;
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

/** A queue of frame callbacks the test runs by hand, so a leftover frame is visible. */
function fakePage(t: TestContext, scheme = "dark") {
  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    window: globals.window,
    getComputedStyle: globals.getComputedStyle,
    requestAnimationFrame: globals.requestAnimationFrame,
    cancelAnimationFrame: globals.cancelAnimationFrame,
  };
  const frames = new Map<number, (now: number) => void>();
  let next = 1;
  globals.document = {
    documentElement: { dataset: { colorScheme: scheme } },
    createElement: (tag: string) =>
      tag === "canvas" ? new FakeCanvas(new FakeContext()) : { style: {}, remove: () => undefined },
  };
  globals.window = { devicePixelRatio: 2 };
  globals.getComputedStyle = () => ({ color: "oklch(0.72 0.12 262)" });
  globals.requestAnimationFrame = (callback: (now: number) => void) => {
    frames.set(next, callback);
    return next++;
  };
  globals.cancelAnimationFrame = (id: number) => frames.delete(id);
  t.after(() => Object.assign(globals, before));
  return {
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
