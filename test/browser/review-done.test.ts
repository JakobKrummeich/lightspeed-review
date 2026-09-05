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
});

test("ending is the sidebar's Send & End, so the card says what goes with it", () => {
  // Nothing queued says nothing: a line about an empty queue is furniture.
  assert.doesNotMatch(renderReviewDone(0), /queued/);
  assert.match(renderReviewDone(1), /Your one queued note goes with it\./);
  assert.match(renderReviewDone(3), /Your 3 queued notes go with it\./);
});

test("the card says approved is not yet done: nothing leaves until the reviewer says", () => {
  assert.match(renderReviewDone(0), /nothing is sent until you say so\./);
});
