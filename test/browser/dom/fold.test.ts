import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  anchored,
  foldAnchored,
  MAX_ANIMATED_FOLD_PX,
  type Anchor,
} from "../../../src/browser/dom/fold.ts";
import { FOLD_DURATION_MS, foldProgress } from "../../../src/browser/scroll-anchor.ts";
import { asElement, FakeElement } from "./fake-diff-dom.ts";

/**
 * Page as a fold sees it: banner, then scroller holding spacer/above/header/content/below —
 * the shape both arithmetic cases need (height above the anchor, foldable block below).
 */
interface Page {
  scroller: FakeElement;
  /** 8000px of review already scrolled through. */
  spacer: FakeElement;
  /** 5000px that can fold away above the anchor. */
  above: FakeElement;
  header: FakeElement;
  /** 1000px the header controls, below it. */
  content: FakeElement;
  below: FakeElement;
}

function page(): Page {
  const body = new FakeElement("body");
  const banner = new FakeElement();
  banner.ownHeight = 60;
  const scroller = new FakeElement("main", 'class="lsr-review"');
  // A screenful, so the fake clamps offsets past the end like a browser.
  scroller.clientHeight = 900;
  const spacer = new FakeElement();
  spacer.ownHeight = 8000;
  const above = new FakeElement();
  above.ownHeight = 5000;
  const header = new FakeElement("button", 'class="lsr-file-header"');
  header.ownHeight = 40;
  const content = new FakeElement("div", 'class="lsr-file-diff"');
  content.ownHeight = 1000;
  const below = new FakeElement();
  below.ownHeight = 9000;
  body.append(banner);
  body.append(scroller);
  for (const child of [spacer, above, header, content, below]) scroller.append(child);
  return { scroller, spacer, above, header, content, below };
}

const topOf = (element: FakeElement): number => element.getBoundingClientRect().top;

/** What every caller but a finished group asks for: hold this, wherever it is. */
const hold = (element: FakeElement): Anchor => ({ element: asElement(element), walk: false });

/** And what a finished group asks for: bring this back onto the screen. */
const walk = (element: FakeElement): Anchor => ({ element: asElement(element), walk: true });

/** A frame clock the test drives, standing in for the browser's. */
interface Clock {
  /** Runs every frame waiting, `ms` later. Returns how many there were. */
  frame(ms: number): number;
  pending(): number;
}

function installClock(t: TestContext, options: { reducedMotion?: boolean } = {}): Clock {
  const real = {
    frame: globalThis.requestAnimationFrame,
    performance: globalThis.performance,
    window: globalThis.window,
  };
  let now = 0;
  let waiting: ((time: number) => void)[] = [];
  Object.assign(globalThis, {
    performance: { now: () => now },
    requestAnimationFrame: (callback: (time: number) => void) => waiting.push(callback),
    window: { matchMedia: () => ({ matches: options.reducedMotion === true }) },
  });
  t.after(() => Object.assign(globalThis, real));
  return {
    frame(ms) {
      now += ms;
      const due = waiting;
      waiting = [];
      for (const callback of due) callback(now);
      return due.length;
    },
    pending: () => waiting.length,
  };
}

test("an anchor off the top of the screen is left there when nobody asked for a walk", () => {
  const { scroller, header, content } = page();
  // Ticked at the foot of a long diff: the header is off-screen above; holding it means leaving it there.
  scroller.scrollTop = 14000;
  assert.equal(topOf(header), -940);

  foldAnchored([{ content: asElement(content), expanded: false, animated: true }], hold(header));

  assert.equal(content.hidden, true);
  assert.equal(topOf(header), -940, "not hauled onto the screen");
  assert.equal(scroller.scrollTop, 14000, "and the review did not travel at all");
});

test("a walk with no frame clock happens at once, and still pays for itself", () => {
  const { scroller, header, content } = page();
  scroller.scrollTop = 14000;

  foldAnchored([{ content: asElement(content), expanded: false, animated: true }], walk(header));

  assert.equal(content.hidden, true);
  assert.equal(topOf(header), 60, "the anchor is walked to the scroller's top edge");
  assert.equal(scroller.scrollTop, 13000);
});

test("a visible anchor keeps the exact position it had", () => {
  const { scroller, above, header, content } = page();
  // 5000px above the anchor collapses under a visible header: that is what moves it.
  scroller.scrollTop = 8500;
  const before = topOf(header);
  assert.equal(before, 4560);

  foldAnchored([{ content: asElement(above), expanded: false, animated: true }], hold(header));

  assert.equal(topOf(header), before);
  assert.equal(scroller.scrollTop, 3500);
  assert.equal(content.hidden, false, "nothing else was touched");
});

test("a fold of a block nobody can measure against changes nothing but the block", () => {
  const loose = new FakeElement();
  const content = new FakeElement();
  loose.append(content);

  foldAnchored([{ content: asElement(content), expanded: false, animated: true }], hold(loose));

  assert.equal(content.hidden, true);
});

test("with no anchor at all the fold still happens", () => {
  const { content } = page();

  foldAnchored([{ content: asElement(content), expanded: false, animated: true }], null);

  assert.equal(content.hidden, true);
});

test("a fold runs over frames, and the anchor does not drift through any of them", (t) => {
  const clock = installClock(t);
  const { scroller, above, header, content } = page();
  scroller.scrollTop = 8500;
  const before = topOf(header);

  foldAnchored([{ content: asElement(above), expanded: false, animated: true }], hold(header));

  assert.equal(above.style.height, "5000px");
  assert.equal(topOf(header), before);
  assert.equal(above.hidden, false, "what is folding is on screen the whole way down");

  clock.frame(40);
  const quarter = Number.parseFloat(above.style.height);
  assert.ok(quarter > 0 && quarter < 5000, `mid-fold height, not ${above.style.height}`);
  assert.equal(quarter, 5000 * (1 - foldProgress(40)));
  assert.equal(topOf(header), before, "a quarter of the way in");

  clock.frame(40);
  assert.equal(topOf(header), before, "half way");

  clock.frame(FOLD_DURATION_MS);
  assert.equal(above.hidden, true, "the fold is over");
  assert.equal(above.style.height, "", "and the block is back to its resting state");
  assert.equal(topOf(header), before);
  assert.equal(scroller.scrollTop, 3500);
  assert.equal(clock.pending(), 0, "nothing is left running");
  assert.equal(content.hidden, false);
});

test("an expansion is folded open the same way, from nothing to its own height", (t) => {
  const clock = installClock(t);
  const { scroller, above, header } = page();
  above.hidden = true;
  scroller.scrollTop = 3500;
  const before = topOf(header);

  foldAnchored([{ content: asElement(above), expanded: true, animated: true }], hold(header));

  assert.equal(above.hidden, false);
  assert.equal(above.style.height, "0px", "it opens from nothing");
  assert.equal(topOf(header), before);

  clock.frame(40);
  assert.ok(Number.parseFloat(above.style.height) > 0, "it is on its way to 5000px");
  assert.equal(topOf(header), before, "and the anchor has not moved for it");

  clock.frame(FOLD_DURATION_MS);
  assert.equal(above.style.height, "");
  assert.equal(above.layoutHeight, 5000);
  assert.equal(topOf(header), before);
  assert.equal(scroller.scrollTop, 8500);
});

test("a reviewer who asked for less motion gets the fold in one step", (t) => {
  const clock = installClock(t, { reducedMotion: true });
  const { scroller, above, header } = page();
  scroller.scrollTop = 8500;
  const before = topOf(header);

  foldAnchored([{ content: asElement(above), expanded: false, animated: true }], hold(header));

  assert.equal(above.hidden, true);
  assert.equal(clock.pending(), 0, "no clock was started");
  assert.equal(topOf(header), before, "still anchored, which is not a motion");
});

test("less motion still gets the walk, in one step rather than none", (t) => {
  // The walk is a scroll, not an animation: less motion means it happens at once, not not at all.
  const clock = installClock(t, { reducedMotion: true });
  const { scroller, header, content } = page();
  scroller.scrollTop = 14000;

  foldAnchored([{ content: asElement(content), expanded: false, animated: true }], walk(header));

  assert.equal(content.hidden, true);
  assert.equal(clock.pending(), 0, "no clock was started");
  assert.equal(topOf(header), 60, "and the anchor arrived at the top edge anyway");
  assert.equal(scroller.scrollTop, 13000);
});

test("a step the plan did not mark for animation is not animated", (t) => {
  const clock = installClock(t);
  const { above } = page();

  foldAnchored([{ content: asElement(above), expanded: false, animated: false }], null);

  assert.equal(above.hidden, true);
  assert.equal(clock.pending(), 0);
});

test("a block taller than a frame can relayout folds in one step, still anchored", (t) => {
  const clock = installClock(t);
  const { scroller, above, header } = page();
  above.ownHeight = MAX_ANIMATED_FOLD_PX + 1;
  // Far enough down that the review can still pay for a block this size.
  scroller.scrollTop = 25000;
  const before = topOf(header);

  foldAnchored([{ content: asElement(above), expanded: false, animated: true }], hold(header));

  assert.equal(above.hidden, true, "no clock is worth this many pixels a frame");
  assert.equal(clock.pending(), 0);
  assert.equal(topOf(header), before);
});

test("a block just inside the budget is still animated", (t) => {
  const clock = installClock(t);
  const { above } = page();
  above.ownHeight = MAX_ANIMATED_FOLD_PX;

  foldAnchored([{ content: asElement(above), expanded: false, animated: true }], null);

  assert.equal(above.hidden, false, "it is folding, not folded");
  assert.equal(clock.pending(), 1);
});

test("the budget is spent on what the block measures, not on what is rendered inside it", (t) => {
  // Counting rows would count the hidden file's rows and refuse to animate the one movement the
  // reviewer watches; the budget must be what the block measures.
  const clock = installClock(t);
  const { above, content } = page();
  above.innerHTML = "<tr><td>line</td></tr>".repeat(5000);
  above.ownHeight = 800;

  foldAnchored(
    [
      { content: asElement(content), expanded: false, animated: false },
      { content: asElement(above), expanded: false, animated: true },
    ],
    null,
  );

  assert.equal(content.hidden, true, "the inner block was shut at once");
  assert.equal(above.hidden, false, "and the outer one is folding over it");
  assert.equal(clock.pending(), 1);
});

test("a block folding over one that shut inside it keeps the height it started with", (t) => {
  // Measured before the file inside is taken out: the reviewer watches the whole group fold,
  // not the file vanish first.
  const clock = installClock(t);
  const group = new FakeElement();
  const file = new FakeElement();
  file.ownHeight = 1000;
  group.ownHeight = 800;
  group.append(file);
  assert.equal(group.layoutHeight, 1800);

  foldAnchored(
    [
      { content: asElement(file), expanded: false, animated: false },
      { content: asElement(group), expanded: false, animated: true },
    ],
    null,
  );

  assert.equal(file.hidden, true, "the file is shut at once, inside the group");
  assert.equal(group.style.height, "1800px", "whose pixels are still the group's");
  clock.frame(FOLD_DURATION_MS);
  assert.equal(group.hidden, true);
});

test("a second fold of the same block takes it over rather than fighting it", (t) => {
  const clock = installClock(t);
  const { scroller, above, header } = page();
  scroller.scrollTop = 8500;
  foldAnchored([{ content: asElement(above), expanded: false, animated: true }], hold(header));
  clock.frame(40);

  // The reviewer changed their mind mid-fold: it opens again from where it got to.
  foldAnchored([{ content: asElement(above), expanded: true, animated: true }], hold(header));
  const resumed = Number.parseFloat(above.style.height);

  // Past the replaced fold's deadline while the replacement runs: its already-requested frame
  // arrives here, and settling now would hide a block mid-open.
  clock.frame(120);
  assert.equal(above.hidden, false, "the fold it replaced did not settle on top of it");
  assert.ok(
    Number.parseFloat(above.style.height) > resumed,
    "and the block is still on its way open",
  );

  clock.frame(FOLD_DURATION_MS);
  assert.ok(resumed > 0 && resumed < 5000, `resumed from ${resumed}`);
  assert.equal(above.hidden, false);
  assert.equal(above.style.height, "");
  assert.equal(above.layoutHeight, 5000);
});

test("a reviewer who scrolls mid-fold is left where they scrolled to", (t) => {
  const clock = installClock(t);
  const { scroller, above, header } = page();
  scroller.scrollTop = 8500;

  foldAnchored([{ content: asElement(above), expanded: false, animated: true }], hold(header));
  clock.frame(40);
  const held = scroller.scrollTop;

  // Wheel flick mid-fold: unnoticed, the next frame would put the offset back and the review
  // would read as refusing to scroll.
  scroller.scrollTop = held - 600;
  clock.frame(40);
  assert.equal(scroller.scrollTop, held - 600, "the fold let go of the offset");

  clock.frame(FOLD_DURATION_MS);
  assert.equal(above.hidden, true, "the fold itself finished all the same");
  assert.equal(scroller.scrollTop, held - 600, "and never took the offset back");
});

test("an offset the browser clamps is not mistaken for the reviewer scrolling", (t) => {
  const clock = installClock(t);
  const { scroller, above, header } = page();
  // Every scroller clamps at its end: the fold asks for more and gets less, and that is not a reviewer.
  installCap(scroller, 4000);
  above.hidden = true;
  scroller.scrollTop = 3500;

  foldAnchored([{ content: asElement(above), expanded: true, animated: true }], hold(header));
  clock.frame(80);
  assert.equal(scroller.scrollTop, 4000, "the write was clamped");

  // The block shrinks below its measure (failed image, narrower re-render): the needed offset is
  // legal again, and a hold that let go on the clamp would pin the reviewer at the review's end.
  above.ownHeight = 300;
  clock.frame(FOLD_DURATION_MS);

  assert.ok(scroller.scrollTop < 4000, `still holding, at ${scroller.scrollTop}`);
  assert.equal(topOf(header), 4560, "which is where the anchor was all along");
});

/** A fixed end to a scroller, whatever its content does: what a browser clamps against. */
function installCap(scroller: FakeElement, cap: number): void {
  let offset = scroller.scrollTop;
  Object.defineProperty(scroller, "scrollTop", {
    get: () => offset,
    set: (value: number) => {
      offset = Math.max(0, Math.min(value, cap));
    },
  });
}

test("a change with no fold at all is anchored the same way", () => {
  const { scroller, above, header, content } = page();
  scroller.scrollTop = 8500;
  const before = topOf(header);

  // Diff-form swap: no animation, no clock, one correction after heights change.
  const returned = anchored(hold(header), () => {
    above.ownHeight = 2000;
    return content;
  });

  assert.equal(returned, content, "whatever the change returned comes back");
  assert.equal(topOf(header), before);
  assert.equal(scroller.scrollTop, 5500);
});

test("a change with nothing to anchor against still happens", () => {
  const loose = new FakeElement();

  const returned = anchored(hold(loose), () => "done");

  assert.equal(returned, "done");
});
