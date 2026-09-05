import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountAnnotationPopup } from "../../../src/browser/dom/annotation-popup.ts";
import type { AnnotationPrompt } from "../../../src/session-store.ts";
import { asSelection, diffFileBlock, diffRoot, fakeRange, type FakeElement } from "./fake-dom.ts";
import { keydown } from "./fake-keys.ts";
import {
  asDiffRoot,
  installPopupDom,
  placedSelection,
  type FakePopupDom,
  type FakeScreen,
  type FakeSelectionRect,
} from "./fake-popup-dom.ts";

/** Where the reviewer dragged, and the screen they dragged on. */
interface Drag {
  rect?: Partial<FakeSelectionRect>;
  screen?: Partial<FakeScreen>;
}

/**
 * The popup over one selected line, drag already played: every test starts
 * here, since the popup only exists once a selection put it on screen.
 */
async function popupOverSelection(
  t: TestContext,
  drag: Drag = {},
): Promise<{
  dom: FakePopupDom;
  queued: AnnotationPrompt[][];
  root: FakeElement;
  selection: () => Selection;
}> {
  const dom = installPopupDom((restore) => t.after(restore), drag.screen);
  const { block, lines } = diffFileBlock({
    file: "src/api/users.ts",
    group: "API Handlers",
    lines: [{ new: 12, prefix: "+", pieces: ["const user = fetchUser(id);"] }],
  });
  const root = diffRoot(block);
  const queued: AnnotationPrompt[][] = [];
  const selection = (): Selection =>
    placedSelection(
      asSelection(
        fakeRange(
          root,
          { node: lines[0]!.texts[0]!, offset: 0 },
          { node: lines[0]!.texts[0]!, offset: 27 },
        ),
      ),
      drag.rect,
    );

  mountAnnotationPopup({ diffRoot: asDiffRoot(root), onQueue: (prompts) => queued.push(prompts) });
  await dom.select(selection());

  return { dom, queued, root, selection };
}

/** What the popup queued, flattened to the one annotation these tests make. */
const only = (queued: AnnotationPrompt[][]): AnnotationPrompt | undefined => queued[0]?.[0];

test("a selection puts the popup on screen with a comment box", async (t) => {
  const { dom } = await popupOverSelection(t);

  assert.equal(dom.popup.hidden, false);
  assert.ok(dom.commentBox(), "the reviewer has somewhere to type");
});

test("the popup hangs under a selection with room beneath it", async (t) => {
  const { dom } = await popupOverSelection(t, { rect: { top: 24, bottom: 40, left: 12 } });

  assert.equal(dom.popup.style.top, "48px");
  assert.equal(dom.popup.style.left, "12px");
});

test("a selection at the foot of the screen puts the popup above it, button and all", async (t) => {
  // The reported bug: below the selection the popup's foot, which is the Queue
  // Feedback button, sat past the bottom edge and was barely pressable.
  const { dom } = await popupOverSelection(t, {
    rect: { top: 700, bottom: 760, left: 12 },
    screen: { innerWidth: 1000, innerHeight: 800 },
  });

  const top = Number.parseInt(dom.popup.style.top ?? "", 10);
  assert.equal(top, 392, "above the selection: 700 - 8 - 300");
  assert.ok(top + dom.popup.size.height <= 800, "the whole popup, button included, is on screen");
});

test("a selection at the right edge pulls the popup back onto the screen", async (t) => {
  // The panel owns the right 22rem, so selections do end this far over.
  const { dom } = await popupOverSelection(t, {
    rect: { top: 24, bottom: 40, left: 940 },
    screen: { innerWidth: 1000, innerHeight: 800 },
  });

  const left = Number.parseInt(dom.popup.style.left ?? "", 10);
  assert.equal(left, 640, "1000 - 8 - 352");
  assert.ok(left + dom.popup.size.width <= 1000);
});

test("a scrolled page places the popup by the page, not by the screen", async (t) => {
  // `position: absolute` means scroll is added to a fit decided against the
  // screen. No document scroll reachable today; pins the wiring, not a symptom.
  const { dom } = await popupOverSelection(t, {
    rect: { top: 24, bottom: 40, left: 12 },
    screen: { scrollX: 5, scrollY: 1200 },
  });

  assert.equal(dom.popup.style.top, "1248px");
  assert.equal(dom.popup.style.left, "17px");
});

test("Enter in the comment box queues the feedback, as the button does", async (t) => {
  const { dom, queued } = await popupOverSelection(t);
  const box = dom.commentBox();
  assert.ok(box);
  box.value = "this reads the user twice";

  const event = keydown(box);
  dom.popup.dispatch("keydown", event);

  assert.equal(event.defaultPrevented, true, "the keystroke queues, it does not type");
  assert.equal(only(queued)?.comment, "this reads the user twice");
  assert.equal(only(queued)?.file, "src/api/users.ts");
  assert.equal(only(queued)?.selected_text, "+const user = fetchUser(id);");
  assert.equal(dom.popup.hidden, true, "the popup is done with");
  assert.equal(dom.cleared, 1, "and the selection it was about is dropped");
});

test("clicking Queue Feedback queues the same annotation", async (t) => {
  const { dom, queued } = await popupOverSelection(t);
  const box = dom.commentBox();
  assert.ok(box);
  box.value = "this reads the user twice";

  dom.popup.dispatch("click", { target: dom.popup.querySelector("#lsr-queue-feedback") });

  assert.equal(only(queued)?.comment, "this reads the user twice");
  assert.equal(dom.popup.hidden, true);
});

test("a second Enter after a queue does not queue the annotation again", async (t) => {
  const { dom, queued } = await popupOverSelection(t);
  const box = dom.commentBox();
  assert.ok(box);
  box.value = "this reads the user twice";
  dom.popup.dispatch("keydown", keydown(box));

  dom.popup.dispatch("keydown", keydown(box));

  assert.equal(queued.length, 1, "the selection and the comment are both spent");
  assert.equal(box.value, "", "the box the reviewer typed into was emptied");
});

test("Shift+Enter is left to the browser, so the comment keeps growing", async (t) => {
  const { dom, queued } = await popupOverSelection(t);
  const box = dom.commentBox();
  assert.ok(box);
  box.value = "first line";

  const event = keydown(box, { shiftKey: true });
  dom.popup.dispatch("keydown", event);

  assert.equal(event.defaultPrevented, false);
  assert.equal(box.value, "first line");
  assert.deepEqual(queued, []);
});

test("Ctrl+Enter types the newline browsers leave out", async (t) => {
  const { dom, queued } = await popupOverSelection(t);
  const box = dom.commentBox();
  assert.ok(box);
  box.value = "onetwo";
  box.setSelectionRange(3, 3);

  const event = keydown(box, { ctrlKey: true });
  dom.popup.dispatch("keydown", event);

  assert.equal(event.defaultPrevented, true);
  assert.equal(box.value, "one\ntwo");
  assert.deepEqual(queued, []);
});

test("Enter on an empty comment queues nothing and leaves the box empty", async (t) => {
  const { dom, queued } = await popupOverSelection(t);
  const box = dom.commentBox();
  assert.ok(box);

  const event = keydown(box);
  dom.popup.dispatch("keydown", event);

  assert.deepEqual(queued, [], "an empty comment is not feedback");
  assert.equal(event.defaultPrevented, true);
  assert.equal(box.value, "", "no blank line hides the placeholder that says what to type");
  assert.equal(dom.popup.hidden, false, "the popup waits for the comment");
});

test("Enter from anywhere but the comment box is not a queue", async (t) => {
  const { dom, queued } = await popupOverSelection(t);
  const box = dom.commentBox();
  assert.ok(box);
  box.value = "this reads the user twice";

  const event = keydown(dom.popup.querySelector("#lsr-queue-feedback"));
  dom.popup.dispatch("keydown", event);

  assert.deepEqual(queued, []);
  assert.equal(event.defaultPrevented, false);
});
