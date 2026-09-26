import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { warpSend } from "../../../src/browser/dom/warp-send.ts";
import { asElement, FakeBox, FakeTextArea, installLightDom } from "./fake-light-dom.ts";

/**
 * A panel with Send at (600, 700) 100×40: a loose draft card (bubble and all),
 * a reply bubble inside a thread card, and the compose box.
 */
function panel(t: TestContext, typed = "and the changelog") {
  const page = installLightDom(t);
  const bubble = (top: number) =>
    new FakeBox("div", "lsr-message lsr-draft").at({ left: 420, top, width: 260, height: 40 });
  const card = new FakeBox("article", "lsr-thread lsr-pill")
    .at({ left: 410, top: 100, width: 280, height: 90 })
    .append(bubble(140));
  const thread = new FakeBox("article", "lsr-thread").append(bubble(300));
  const box = new FakeTextArea({ id: "lsr-general-comment" }).at({
    left: 410,
    top: 620,
    width: 280,
    height: 60,
  });
  box.value = typed;
  const send = new FakeBox("button", "lsr-primary", { id: "lsr-send" }).at({
    left: 600,
    top: 700,
    width: 100,
    height: 40,
  });
  const end = new FakeBox("button", "lsr-secondary", { id: "lsr-send-end" }).at({
    left: 480,
    top: 700,
    width: 100,
    height: 40,
  });
  const root = new FakeBox("aside").append(card, thread, box, send, end);
  return { page, root, card, box, send, end };
}

const ghostsIn = (page: { body: FakeBox }): FakeBox[] =>
  page.body.querySelectorAll(".lsr-warp-ghost");

test("every draft on screen streaks into the button that sent it", (t) => {
  const { page, root, send } = panel(t);

  warpSend(asElement(root), false);

  const ghosts = ghostsIn(page);
  // The card once, not its bubble again; the reply bubble; the words in the box.
  assert.deepEqual(
    ghosts.map((ghost) => ghost.style.getPropertyValue("top")),
    ["100px", "300px", "620px"],
  );
  // From the card's right edge (690, 145) to the button's centre (650, 720).
  assert.equal(ghosts[0]?.style.getPropertyValue("--lsr-warp-dx"), "-40px");
  assert.equal(ghosts[0]?.style.getPropertyValue("--lsr-warp-dy"), "575px");
  assert.deepEqual(
    ghosts.map((ghost) => ghost.style.getPropertyValue("--lsr-warp-delay")),
    ["0ms", "70ms", "140ms"],
  );
  assert.equal(send.getAttribute("data-light"), "flare");
});

test("the box's words fly as the bubble they become, never as a second compose box", (t) => {
  const { page, root } = panel(t);

  warpSend(asElement(root), false);

  const copy = ghostsIn(page)[2]?.children[0];
  assert.equal(copy?.className, "lsr-message lsr-draft");
  assert.equal(copy?.textContent, "and the changelog");
  assert.equal(page.body.querySelector("#lsr-general-comment"), null);
});

test("Send & End flares its own button", (t) => {
  const { root, send, end } = panel(t);

  warpSend(asElement(root), true);

  assert.equal(end.getAttribute("data-light"), "flare");
  assert.equal(send.getAttribute("data-light"), null);
});

test("a draft scrolled out of sight sends no streak, and an empty box none either", (t) => {
  const { page, root, card } = panel(t, "   ");
  card.at({ left: 410, top: 900, width: 280, height: 90 });
  card.children[0]!.at({ left: 420, top: -200, width: 260, height: 40 });

  warpSend(asElement(root), false);

  assert.equal(ghostsIn(page).length, 1, "only the reply bubble is in sight");
});

test("with nothing in sight the button still flares, over no layer at all", (t) => {
  const { page, root, send } = panel(t, "");
  for (const draft of root.querySelectorAll(".lsr-thread")) draft.remove();

  warpSend(asElement(root), false);

  assert.equal(send.getAttribute("data-light"), "flare");
  assert.equal(page.body.children.length, 0);
});

test("the streaks and the flare are gone when the moment is", (t) => {
  const { page, root, send } = panel(t);
  warpSend(asElement(root), false);

  t.mock.timers.tick(1300);

  assert.equal(page.body.children.length, 0);
  assert.equal(send.getAttribute("data-light"), null);
});

test("a panel with no button to fly into lights nothing", (t) => {
  const { page, root, send, end } = panel(t);
  send.remove();
  end.remove();

  warpSend(asElement(root), false);

  assert.equal(page.body.children.length, 0);
});
