import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { aimAccelerator } from "../../../src/browser/dom/accelerator.ts";
import type { ProgressChange } from "../../../src/browser/progress-bar.ts";
import { asElement, FakeBox, installLightDom } from "./fake-light-dom.ts";

/**
 * Two segments from x=100, their fills at `widths`: the first 100px wide, the
 * second 196px after a 4px gap.
 */
function segmentsAt(widths: [string, string]): FakeBox[] {
  const segment = (index: number, left: number, width: number) =>
    new FakeBox("button", "lsr-progress-segment", { "data-group-index": String(index) })
      .at({ left, top: 10, width, height: 12 })
      .append(new FakeBox("span", "lsr-progress-fill", { style: `width: ${widths[index]}` }));
  return [segment(0, 100, 100), segment(1, 204, 196)];
}

function bar(t: TestContext) {
  installLightDom(t);
  const segments = segmentsAt(["0%", "0%"]);
  const progress = new FakeBox("span", "lsr-progress").append(
    new FakeBox("span", "lsr-progress-bar").at({ left: 100, top: 10, width: 300, height: 12 }),
  );
  progress.children[0]!.append(...segments);
  const tick = new FakeBox("input", "lsr-approved", { "data-file": "src/a.ts" });
  return { progress, segments, tick };
}

const asInput = (box: FakeBox): HTMLInputElement => box as unknown as HTMLInputElement;

/** A tick patched in place; `grow` stands in for the width patch. */
function accelerate(
  progress: FakeBox,
  change: ProgressChange | undefined,
  tick: FakeBox,
  grow = () => {},
): void {
  aimAccelerator(asElement(progress), change).fire(asElement(tick), grow);
}

const named = (box: FakeBox, name: string): FakeBox[] => box.querySelectorAll(`.${name}`);

test("a tick that grows a chapter runs a particle from the bar's start to the fill's new edge", (t) => {
  const { progress, segments, tick } = bar(t);
  const grown = segments[1]!;

  accelerate(progress, { kind: "partial", index: 1, share: 0.5 }, tick);

  const [photon] = named(grown, "lsr-light-photon");
  // From the bar's left edge, 104px behind the segment's, to half of its 196px.
  assert.equal(photon?.style.getPropertyValue("--lsr-photon-from"), "-104px");
  assert.equal(photon?.style.getPropertyValue("--lsr-photon-to"), "98px");
  // A farther edge is a longer run: 220ms plus half the 202px travelled.
  assert.equal(grown.style.getPropertyValue("--lsr-photon-ms"), "321ms");
  assert.equal(photon?.style.getPropertyValue("--lsr-photon-ms"), "321ms");
  assert.equal(named(grown, "lsr-light-edge")[0]?.style.getPropertyValue("--lsr-edge-at"), "50%");
  assert.equal(grown.getAttribute("data-light"), "run");
  assert.equal(tick.getAttribute("data-light"), "tick");
  assert.deepEqual(named(grown, "lsr-light-flash"), [], "only a finished chapter flashes");
  assert.deepEqual(named(segments[0]!, "lsr-light-photon"), [], "the other segment stays dark");
});

test("a long run is capped, so a wide bar does not keep the moment going", (t) => {
  const { progress, segments, tick } = bar(t);
  segments[1]!.at({ left: 1204, top: 10, width: 800, height: 12 });

  accelerate(progress, { kind: "partial", index: 1, share: 1 }, tick);

  assert.equal(segments[1]!.style.getPropertyValue("--lsr-photon-ms"), "600ms");
});

test("finishing a chapter flashes its segment and sends one glint across its fill", (t) => {
  const { progress, segments, tick } = bar(t);

  accelerate(progress, { kind: "chapter", index: 0, share: 1 }, tick);

  const [done, other] = segments;
  assert.equal(named(done!, "lsr-light-flash").length, 1);
  const glints = named(done!, "lsr-light-glint");
  assert.equal(glints.length, 1);
  // After the particle lands (220ms + half its 100px run).
  assert.equal(glints[0]?.style.getPropertyValue("--lsr-glint-at"), "390ms");
  assert.equal(glints[0]?.parentElement?.className, "lsr-progress-fill", "clipped by the fill");
  assert.deepEqual(named(other!, "lsr-light-glint"), []);
});

test("finishing the review sends a glint down every segment, one after the other", (t) => {
  const { progress, segments, tick } = bar(t);

  accelerate(progress, { kind: "all", index: 1, share: 1 }, tick);

  const at = (segment: FakeBox) =>
    named(segment, "lsr-light-glint").map((glint) =>
      glint.style.getPropertyValue("--lsr-glint-at"),
    );
  // The run is 220 + (196 + 104) / 2 = 370ms; the sweep starts 420ms after it, 90ms apart.
  assert.deepEqual(at(segments[0]!), ["790ms"]);
  assert.deepEqual(at(segments[1]!), ["490ms", "880ms"]);
});

test("every light the moment laid down is gone when it is over", (t) => {
  const { progress, segments, tick } = bar(t);
  accelerate(progress, { kind: "all", index: 1, share: 1 }, tick);

  t.mock.timers.tick(2400);

  for (const segment of segments) {
    assert.equal(segment.getAttribute("data-light"), null);
    assert.deepEqual(
      segment.querySelectorAll("span").map((left) => left.className),
      ["lsr-progress-fill"],
    );
  }
  assert.equal(tick.getAttribute("data-light"), null);
});

test("an untick glows nothing on the bar, and a bar too narrow to be drawn has nowhere to run", (t) => {
  const { progress, segments, tick } = bar(t);

  accelerate(progress, undefined, tick);
  segments[0]!.at({ left: 0, top: 0, width: 0, height: 0 });
  accelerate(progress, { kind: "partial", index: 0, share: 0.5 }, tick);

  assert.deepEqual(named(progress, "lsr-light-photon"), []);
  assert.equal(segments[0]!.getAttribute("data-light"), null);
});

test("the same moment twice restarts rather than stacking two endings", (t) => {
  const { progress, segments, tick } = bar(t);
  const change = { kind: "partial", index: 0, share: 0.5 } as const;
  // A 245ms run: 220ms plus half the 50px from the bar's start.
  accelerate(progress, change, tick);
  t.mock.timers.tick(200);

  accelerate(progress, change, tick);
  // The first moment's timer runs out here, and must not take the second one's state down.
  t.mock.timers.tick(100);

  assert.equal(segments[0]!.getAttribute("data-light"), "run");
});

test("the fill is grown once the run is lit, so it grows behind the particle", (t) => {
  const { progress, segments, tick } = bar(t);
  const seen: (string | null)[] = [];

  accelerate(progress, { kind: "partial", index: 1, share: 0.5 }, tick, () =>
    seen.push(segments[1]!.getAttribute("data-light")),
  );

  assert.deepEqual(seen, ["run"]);
});

test("the growth waits on the particle only until it lands; its sparks play on", (t) => {
  // Regression: the run's state stayed 2400ms, so any width change in that time — an untick —
  // waited behind the particle's delay too, and the segment kept its length forever.
  const { progress, segments, tick } = bar(t);
  accelerate(progress, { kind: "partial", index: 1, share: 0.5 }, tick);

  t.mock.timers.tick(321);

  const [, grown] = segments;
  assert.equal(grown!.getAttribute("data-light"), null);
  assert.equal(grown!.style.getPropertyValue("--lsr-photon-ms"), "");
  const edge = named(grown!, "lsr-light-edge")[0];
  assert.equal(edge?.style.getPropertyValue("--lsr-photon-ms"), "321ms", "the spark keeps its own");
});

test("an untick mid-run takes the run down before its width is written", (t) => {
  const { progress, segments, tick } = bar(t);
  accelerate(progress, { kind: "all", index: 1, share: 1 }, tick);
  t.mock.timers.tick(100);
  const seen: (string | null)[] = [];

  accelerate(progress, undefined, tick, () => seen.push(segments[1]!.getAttribute("data-light")));

  assert.deepEqual(seen, [null], "no delay left for the width to wait on");
  assert.equal(segments[1]!.style.getPropertyValue("--lsr-photon-ms"), "");
  for (const name of ["lsr-light-photon", "lsr-light-edge", "lsr-light-flash", "lsr-light-glint"]) {
    assert.deepEqual(named(progress, name), [], `${name} is gone`);
  }
});

/**
 * A tick that finished the chapter in focus: aimed on the bar as it was, then
 * the whole view is drawn again, the bar with it, at the new widths.
 */
function redrawnBar(t: TestContext) {
  const { progress, tick } = bar(t);
  segmentsAt(["50%", "0%"]).forEach((old, at) => {
    const fill = old.children[0]!;
    progress.children[0]!.children[at]!.children[0]!.setAttribute(
      "style",
      fill.getAttribute("style")!,
    );
  });
  const light = aimAccelerator(asElement(progress), { kind: "chapter", index: 0, share: 1 });
  const redrawn = segmentsAt(["100%", "0%"]);
  progress.children[0]!.children.splice(0, 2);
  progress.children[0]!.append(...redrawn);
  const fill = redrawn[0]!.children[0]!;
  const writes: string[] = [];
  const write = fill.setAttribute.bind(fill);
  fill.setAttribute = (name, value) => {
    writes.push(`${value} [${redrawn[0]!.getAttribute("data-light")}]`);
    write(name, value);
  };
  return { progress, tick, light, redrawn, fill, writes };
}

test("a redrawn bar is set back to the width the tick found, then grown behind the particle", (t) => {
  // Regression: focus mode redrew the bar at its final width before the light ran, so the fill
  // jumped ahead of the particle.
  const { progress, tick, light, redrawn, fill, writes } = redrawnBar(t);

  light.redrawn(asElement(progress), asInput(tick));

  assert.deepEqual(writes, ["width: 50%; transition: none [null]", "width: 100% [run]"]);
  assert.equal(fill.getAttribute("style"), "width: 100%");
  assert.equal(named(redrawn[0]!, "lsr-light-photon").length, 1, "the run plays on the new bar");
  assert.equal(named(redrawn[0]!, "lsr-light-flash").length, 1);
});

test("a redraw that drew the ticked box again glows that one; one that did not glows none", (t) => {
  const { progress, tick, light } = redrawnBar(t);
  const again = new FakeBox("input", "lsr-approved", { "data-file": "src/a.ts" });
  const other = new FakeBox("input", "lsr-approved", { "data-file": "src/b.ts" });
  const root = new FakeBox("main").append(other, again);

  light.redrawn(asElement(root), asInput(tick));

  assert.equal(again.getAttribute("data-light"), "tick");
  assert.equal(other.getAttribute("data-light"), null);
  assert.equal(tick.getAttribute("data-light"), null, "the detached box is not lit for nobody");
  // A sweep has no box at all, and still grows its chapter.
  aimAccelerator(asElement(progress), { kind: "chapter", index: 0, share: 1 }).redrawn(
    asElement(root),
  );
});
