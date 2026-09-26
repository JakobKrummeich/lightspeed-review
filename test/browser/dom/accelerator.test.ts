import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { accelerate } from "../../../src/browser/dom/accelerator.ts";
import { asElement, FakeBox, installLightDom } from "./fake-light-dom.ts";

/** A bar of two segments from x=100: the first 100px wide, the second 196px after a 4px gap. */
function bar(t: TestContext) {
  installLightDom(t);
  const segment = (index: number, left: number, width: number) =>
    new FakeBox("button", "lsr-progress-segment", { "data-group-index": String(index) })
      .at({ left, top: 10, width, height: 12 })
      .append(new FakeBox("span", "lsr-progress-fill"));
  const segments = [segment(0, 100, 100), segment(1, 204, 196)];
  const progress = new FakeBox("span", "lsr-progress").append(
    new FakeBox("span", "lsr-progress-bar").at({ left: 100, top: 10, width: 300, height: 12 }),
  );
  progress.children[0]!.append(...segments);
  const tick = new FakeBox("input", "lsr-approved");
  return { progress, segments, tick };
}

const named = (box: FakeBox, name: string): FakeBox[] => box.querySelectorAll(`.${name}`);

test("a tick that grows a chapter runs a particle from the bar's start to the fill's new edge", (t) => {
  const { progress, segments, tick } = bar(t);
  const grown = segments[1]!;

  accelerate(asElement(progress), { kind: "partial", index: 1, share: 0.5 }, asElement(tick));

  const [photon] = named(grown, "lsr-light-photon");
  // From the bar's left edge, 104px behind the segment's, to half of its 196px.
  assert.equal(photon?.style.getPropertyValue("--lsr-photon-from"), "-104px");
  assert.equal(photon?.style.getPropertyValue("--lsr-photon-to"), "98px");
  // A farther edge is a longer run: 220ms plus half the 202px travelled.
  assert.equal(grown.style.getPropertyValue("--lsr-photon-ms"), "321ms");
  assert.equal(named(grown, "lsr-light-edge")[0]?.style.getPropertyValue("--lsr-edge-at"), "50%");
  assert.equal(grown.getAttribute("data-light"), "run");
  assert.equal(tick.getAttribute("data-light"), "tick");
  assert.deepEqual(named(grown, "lsr-light-flash"), [], "only a finished chapter flashes");
  assert.deepEqual(named(segments[0]!, "lsr-light-photon"), [], "the other segment stays dark");
});

test("a long run is capped, so a wide bar does not keep the moment going", (t) => {
  const { progress, segments, tick } = bar(t);
  segments[1]!.at({ left: 1204, top: 10, width: 800, height: 12 });

  accelerate(asElement(progress), { kind: "partial", index: 1, share: 1 }, asElement(tick));

  assert.equal(segments[1]!.style.getPropertyValue("--lsr-photon-ms"), "600ms");
});

test("finishing a chapter flashes its segment and sends one glint across its fill", (t) => {
  const { progress, segments, tick } = bar(t);

  accelerate(asElement(progress), { kind: "chapter", index: 0, share: 1 }, asElement(tick));

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

  accelerate(asElement(progress), { kind: "all", index: 1, share: 1 }, asElement(tick));

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
  accelerate(asElement(progress), { kind: "all", index: 1, share: 1 }, asElement(tick));

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

  accelerate(asElement(progress), undefined, asElement(tick));
  segments[0]!.at({ left: 0, top: 0, width: 0, height: 0 });
  accelerate(asElement(progress), { kind: "partial", index: 0, share: 0.5 }, asElement(tick));

  assert.deepEqual(named(progress, "lsr-light-photon"), []);
  assert.equal(segments[0]!.getAttribute("data-light"), null);
});

test("the same moment twice restarts rather than stacking two endings", (t) => {
  const { progress, segments, tick } = bar(t);
  const change = { kind: "partial", index: 0, share: 0.5 } as const;
  accelerate(asElement(progress), change, asElement(tick));
  t.mock.timers.tick(2000);

  accelerate(asElement(progress), change, asElement(tick));
  // The first moment's timer runs out here, and must not take the second one's state down.
  t.mock.timers.tick(400);

  assert.equal(segments[0]!.getAttribute("data-light"), "run");
});
