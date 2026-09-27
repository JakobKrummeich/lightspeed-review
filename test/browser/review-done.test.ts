import { test } from "node:test";
import assert from "node:assert/strict";
import { renderReviewDone } from "../../src/browser/review-done.ts";

test("the finish is a dialog with the news and the two ways out", () => {
  const html = renderReviewDone(0);

  assert.match(html, /role="dialog" aria-modal="true" aria-label="Every file is approved"/);
  assert.match(html, /<h2 class="lsr-done-title">Every file is approved<\/h2>/);
  assert.match(html, /<button type="button" class="lsr-primary lsr-done-end">End review<\/button>/);
  assert.match(
    html,
    /<button type="button" class="lsr-secondary lsr-done-stay">Keep looking<\/button>/,
  );
  // The mark is decoration: the sentence carries the meaning for whoever cannot see it.
  assert.match(html, /<span class="lsr-done-mark" aria-hidden="true">✓<\/span>/);
  // The title is the news; a line over it saying the same thing another way was one too many.
  assert.doesNotMatch(html, /Nothing left to read/i);
});

test("ending is the sidebar's Send & End, so the card says what goes with it", () => {
  // Nothing queued says nothing: a line about an empty queue is furniture.
  assert.doesNotMatch(renderReviewDone(0), /queued/);
  assert.match(renderReviewDone(1), /Your one queued note goes with it\./);
  assert.match(renderReviewDone(3), /Your 3 queued notes go with it\./);
});

test("the note offers both ways out and nothing more", () => {
  assert.match(
    renderReviewDone(0),
    /<p class="lsr-done-note">End the review to hand it back to the agent, or keep looking\.<\/p>/,
  );
  assert.match(
    renderReviewDone(2),
    /or keep looking\. Your 2 queued notes go with it\.<\/p>/,
    "the queue is still said after it",
  );
});

test("the heading opens the card, its mark beside it on the same line", () => {
  const html = renderReviewDone(0);

  const head = /<div class="lsr-done-head">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
  // First in reading order, so a screen reader meets the news before anything else.
  assert.match(head, /^\s*<h2 class="lsr-done-title">Every file is approved<\/h2>/);
  assert.match(head, /<span class="lsr-done-mark" aria-hidden="true">✓<\/span>/);
  assert.ok(html.indexOf("lsr-done-head") < html.indexOf("lsr-done-note"), "the note follows");
});
