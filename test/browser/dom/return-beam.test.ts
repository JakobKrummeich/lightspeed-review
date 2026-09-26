import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountPanelLight } from "../../../src/browser/dom/panel-light.ts";
import { returnBeam } from "../../../src/browser/dom/return-beam.ts";
import type { ConversationEntry } from "../../../src/session-store.ts";
import { asElement, FakeBox, installLightDom } from "./fake-light-dom.ts";

/**
 * The header's dot at (500, 10) 8×8 over a panel whose scroll shows y 100–700,
 * holding card `t1` at (410, 300) 280 wide with two agent answers between the
 * reviewer's words.
 */
function page(t: TestContext) {
  const document = installLightDom(t);
  const dot = new FakeBox("span", "lsr-presence-dot").at({
    left: 500,
    top: 10,
    width: 8,
    height: 8,
  });
  document.body.append(dot);
  const message = (role: string) => new FakeBox("div", "lsr-message", { "data-role": role });
  const answers = [message("agent"), message("agent")];
  const card = new FakeBox("article", "lsr-thread", { "data-key": "t1" })
    .at({ left: 410, top: 300, width: 280, height: 80 })
    .append(message("reviewer"), answers[0]!, message("reviewer"), answers[1]!);
  const other = new FakeBox("article", "lsr-thread", { "data-key": "t2" }).at({
    left: 410,
    top: 400,
    width: 280,
    height: 80,
  });
  const scroll = new FakeBox("div", "lsr-panel-scroll")
    .at({ left: 400, top: 100, width: 300, height: 600 })
    .append(card, other);
  const root = new FakeBox("aside").append(scroll);
  document.body.append(root);
  return { document, dot, card, other, answers, scroll, root };
}

const beams = (document: { body: FakeBox }): FakeBox[] =>
  document.body.querySelectorAll(".lsr-light-beam");

/** Where each pulse was laid: left, top, width, height. */
const pulses = (document: { body: FakeBox }): string[][] =>
  document.body
    .querySelectorAll(".lsr-light-pulse")
    .map((pulse) =>
      ["left", "top", "width", "height"].map((name) => pulse.style.getPropertyValue(name)),
    );
const AT_THE_DOT = [["500px", "10px", "8px", "8px"]];

test("a new card in sight gets the beam from the dot, a lap of light and its answer faded in", (t) => {
  const { document, card, other, answers, root } = page(t);

  returnBeam(asElement(root), ["t1"]);

  assert.deepEqual(pulses(document), AT_THE_DOT);
  assert.equal(card.getAttribute("data-light"), "arrive");
  assert.equal(other.getAttribute("data-light"), null, "a card with nothing new stays still");
  // The newest answer, not the older one above it.
  assert.equal(answers[1]!.getAttribute("data-light"), "arrive");
  assert.equal(answers[0]!.getAttribute("data-light"), null);
  const [beam] = beams(document);
  // From the dot's centre (504, 14) straight down to the card's top edge at y=300.
  assert.equal(beam?.style.getPropertyValue("left"), "503px");
  assert.equal(beam?.style.getPropertyValue("top"), "14px");
  assert.equal(beam?.style.getPropertyValue("height"), "286px");
  assert.equal(beam?.style.getPropertyValue("--lsr-beam-turn"), "0rad");
});

test("a card off to the side is reached by a turned beam that lands inside its corner", (t) => {
  const { document, card, root } = page(t);
  card.at({ left: 600, top: 300, width: 100, height: 80 });

  returnBeam(asElement(root), ["t1"]);

  // Aimed 12px inside the card's left corner (612, 300): 108px across, 286px down.
  const beam = beams(document)[0];
  assert.equal(beam?.style.getPropertyValue("height"), `${Math.hypot(108, 286)}px`);
  assert.equal(beam?.style.getPropertyValue("--lsr-beam-turn"), `${Math.atan2(-108, 286)}rad`);
});

test("a new card scrolled out of sight gets no beam: the dot's pulse alone says it", (t) => {
  const { document, card, root } = page(t);
  card.at({ left: 410, top: 760, width: 280, height: 80 });

  returnBeam(asElement(root), ["t1"]);

  assert.deepEqual(pulses(document), AT_THE_DOT);
  assert.equal(card.getAttribute("data-light"), null);
  assert.deepEqual(beams(document), []);
});

test("a folded panel lays nothing out, so only the dot pulses", (t) => {
  const { document, scroll, card, root } = page(t);
  scroll.at({ left: 0, top: 0, width: 0, height: 0 });
  card.at({ left: 0, top: 0, width: 0, height: 0 });

  returnBeam(asElement(root), ["t1"]);

  assert.deepEqual(pulses(document), AT_THE_DOT);
  assert.deepEqual(beams(document), []);
});

test("the pulse outlives the dot it was laid over, which the banner redraws at once", (t) => {
  // Regression: set on the dot as a state, the pulse went with it 10–30ms later and never showed.
  const { document, dot, root } = page(t);

  returnBeam(asElement(root), ["t1"]);
  dot.remove();

  assert.deepEqual(pulses(document), AT_THE_DOT);
  assert.equal(dot.getAttribute("data-light"), null, "nothing is set on the dot itself");
  t.mock.timers.tick(900);
  assert.deepEqual(pulses(document), []);
});

test("the pulse and the beam keep to the dot the banner redrew somewhere else along the header", (t) => {
  // Regression: laid at the old dot's place, the pulse stood 27px off the redrawn dot in Chromium.
  const { document, dot, root } = page(t);
  returnBeam(asElement(root), ["t1"]);

  dot.remove();
  document.body.append(
    new FakeBox("span", "lsr-presence-dot").at({ left: 530, top: 10, width: 8, height: 8 }),
  );
  t.mock.timers.tick(16);

  assert.deepEqual(pulses(document), [["530px", "10px", "8px", "8px"]]);
  const [beam] = beams(document);
  // From the new centre (534, 14) to the card's top edge, still straight down: x 534 is over it.
  assert.equal(beam?.style.getPropertyValue("left"), "533px");
  assert.equal(beam?.style.getPropertyValue("height"), "286px");
});

test("with no dot in the header the card still arrives, without a beam", (t) => {
  const { document, dot, card, root } = page(t);
  dot.remove();

  returnBeam(asElement(root), ["t1"]);

  assert.equal(card.getAttribute("data-light"), "arrive");
  assert.deepEqual(beams(document), []);
});

test("the beam and the card's light are gone when the moment is", (t) => {
  const { document, card, root } = page(t);
  returnBeam(asElement(root), ["t1"]);

  t.mock.timers.tick(1800);

  assert.deepEqual(beams(document), []);
  assert.equal(card.getAttribute("data-light"), null);
});

const asked: ConversationEntry = {
  role: "reviewer",
  at: "2025-01-01T00:01:00.000Z",
  prompts: [{ type: "message", id: "t1", comment: "why?" }],
};
const answered: ConversationEntry = {
  role: "agent",
  at: "2025-01-01T00:02:00.000Z",
  prompts: [{ type: "reply", thread: "t1", comment: "because" }],
};

test("the panel's light beams only for what the agent said since the last draw", (t) => {
  const { document, root } = page(t);
  const light = mountPanelLight(asElement(root), [asked]);

  light.drawn([asked]);
  assert.deepEqual(beams(document), [], "nothing new");
  light.drawn([asked, answered]);
  assert.equal(beams(document).length, 1);
  t.mock.timers.tick(1800);
  light.drawn([asked, answered]);
  assert.deepEqual(beams(document), [], "drawn once is seen");
});

test("every firefly the panel draws flies on the page's one clock, not from its own start", (t) => {
  // Regression: each presence frame redraws the panel, and the new firefly jumped back to the
  // middle of its box.
  const { root } = page(t);
  const layers = [{ startTime: 1234 }, { startTime: 1234 }, { startTime: 1234 }];
  const firefly = Object.assign(new FakeBox("span", "lsr-firefly"), {
    getAnimations: (options: { subtree?: boolean }) => (options.subtree ? layers : []),
  });
  root.append(firefly);

  mountPanelLight(asElement(root), []).drawn([]);

  assert.deepEqual(
    layers.map((layer) => layer.startTime),
    [0, 0, 0],
  );
});

test("the panel's light hands a send to Warp Send", (t) => {
  const { root } = page(t);
  const send = new FakeBox("button", "", { id: "lsr-send" });
  root.append(send);

  mountPanelLight(asElement(root), []).sent(false);

  assert.equal(send.getAttribute("data-light"), "flare");
});
