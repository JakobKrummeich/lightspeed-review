import { test } from "node:test";
import assert from "node:assert/strict";
import { wireIntent } from "../../../src/browser/dom/intent-mount.ts";
import { renderIntent } from "../../../src/browser/intent-view.ts";
import { asElement, FakeElement, installFakeDom } from "./fake-diff-dom.ts";

/** The section the shell renders, with a round's reasons drawn into it and wired. */
function block(intents: string[] = ["sign the tokens"]): FakeElement {
  const root = new FakeElement("section", 'id="lsr-intent" class="lsr-intent"');
  installFakeDom(root);
  root.innerHTML = renderIntent({ intents, commits: [] });
  wireIntent(asElement(root));
  return root;
}

function press(root: FakeElement): FakeElement {
  const found = root.querySelector(".lsr-intent-press");
  assert.ok(found, "the block draws no press");
  return found;
}

function body(root: FakeElement): FakeElement {
  const found = root.querySelector(".lsr-intent-body");
  assert.ok(found, "the block draws no body");
  return found;
}

/** What the section's one listener sees: the fake models no bubbling. */
function clickOn(root: FakeElement, target: FakeElement): void {
  root.dispatch("click", { target });
}

test("the press opens the reasons, and the same press puts them away again", () => {
  const root = block();

  clickOn(root, press(root));
  assert.equal(press(root).getAttribute("aria-expanded"), "true");
  assert.equal(body(root).hidden, false);

  clickOn(root, press(root));
  assert.equal(press(root).getAttribute("aria-expanded"), "false");
  assert.equal(body(root).hidden, true);
});

test("a press that lands on the hint is a press on the heading it is part of", () => {
  // The words "press to expand" sit inside the button, so the click's target is
  // the span at least as often as the button itself.
  const root = block();
  const hint = root.querySelector(".lsr-intent-hint");
  assert.ok(hint, "the shut block draws no hint");

  clickOn(root, hint);

  assert.equal(press(root).getAttribute("aria-expanded"), "true");
  assert.equal(body(root).hidden, false);
});

test("a press on the block that is not the heading leaves it as it stands", () => {
  // An open block is a paragraph to read, and selecting a word in it is a click.
  const root = block();
  clickOn(root, press(root));

  clickOn(root, body(root));

  assert.equal(press(root).getAttribute("aria-expanded"), "true");
  assert.equal(body(root).hidden, false);
});

test("a round drawn into the section afterwards is pressable too", () => {
  // The listener is on the section, not on the button: a new round replaces
  // everything inside it, and re-wiring on every round is a listener per round.
  const root = block();
  root.innerHTML = renderIntent({ intents: ["a new reason"], commits: [] });

  clickOn(root, press(root));

  assert.equal(press(root).getAttribute("aria-expanded"), "true");
  assert.equal(body(root).hidden, false);
});
