import { test } from "node:test";
import assert from "node:assert/strict";
import { clampFocus } from "../../src/browser/focus-mode.ts";
import { renderIntent, showIntentFor } from "../../src/browser/intent-view.ts";

test("every stated reason is its own line, in the order the agent gave them", () => {
  const html = renderIntent({
    intents: ["replace session cookies with signed tokens", "drop the legacy /login handler"],
    commits: [],
  });

  const items = [...html.matchAll(/<li class="lsr-intent-item">(.*?)<\/li>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(items, [
    "replace session cookies with signed tokens",
    "drop the legacy /login handler",
  ]);
});

test("the block opens shut: a heading that is a press, and the reasons behind it", () => {
  // The survey is a screen for choosing a chapter on; the reasons are read once,
  // and after that they are a band the reviewer scrolls past every time.
  const html = renderIntent({ intents: ["sign the tokens"], commits: [] });

  assert.match(
    html,
    /<h2 class="lsr-intent-title"><button type="button" class="lsr-intent-press" aria-expanded="false" aria-controls="lsr-intent-body">/,
  );
  assert.match(html, /<div class="lsr-intent-body" id="lsr-intent-body" hidden>/);
  // Behind the press, not beside it: a body outside it is a body the press cannot show.
  const body = /<div class="lsr-intent-body"[^>]*>([\s\S]*)<\/div>/.exec(html)?.[1] ?? "";
  assert.match(body, /lsr-intent-list/);
  assert.match(body, /sign the tokens/);
});

test("a shut block says what pressing it does, in words as well as in an arrow", () => {
  // The arrow alone is chrome anyone can miss; the hint is dropped by the
  // stylesheet once the block is open, when the turned arrow is the whole answer.
  const html = renderIntent({ intents: [], commits: ["some commit"] });

  assert.match(html, /<span class="lsr-intent-hint">press to expand<\/span><\/button>/);
});

test("every draw of the block is a shut one, whatever the round before it was", () => {
  // A new round redraws this from the same render, and a round that states a new
  // reason must not unfold the page under the reviewer's cursor.
  for (const view of [
    { intents: ["a"], commits: [] },
    { intents: [], commits: ["c"] },
  ]) {
    const html = renderIntent(view);

    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /aria-expanded="true"/);
    assert.match(html, /class="lsr-intent-body" id="lsr-intent-body" hidden>/);
  }
});

test("an intent is text, never markup: a page that runs it has lost the review", () => {
  const html = renderIntent({
    intents: ["<script>alert('x')</script> & <b>bold</b>"],
    commits: ["<img src=x onerror=alert(1)>"],
  });

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

/** The map took the block's job: the commits stay recorded, but render nowhere. */
test("commit subjects are recorded but no longer rendered", () => {
  const html = renderIntent({ intents: ["sign the tokens"], commits: ["wire up the signer"] });

  assert.match(html, /sign the tokens/);
  assert.doesNotMatch(html, /wire up the signer/);
  assert.doesNotMatch(html, /lsr-commit/);
  assert.doesNotMatch(html, /commit\(s\) on this branch/);
});

test("a round from before intents existed says so rather than showing an empty block", () => {
  const html = renderIntent({ intents: [], commits: ["some commit"] });

  assert.match(html, /opened without a stated intent/);
  // Behind the press too: the sentence is one of the block's answers, not its heading.
  const body = /<div class="lsr-intent-body"[^>]*>([\s\S]*)<\/div>/.exec(html)?.[1] ?? "";
  assert.match(body, /opened without a stated intent/);
});

/** Nothing to say and nothing to corroborate: the band must not take a row. */
test("nothing at all renders nothing at all", () => {
  assert.equal(renderIntent({ intents: [], commits: [] }), "");
});

test("the block stands beside the survey and goes away beside a chapter", () => {
  const block = { hidden: false };

  showIntentFor(block, 2);
  assert.equal(block.hidden, true, "a chapter is what the reviewer opened it to read");

  showIntentFor(block, undefined);
  assert.equal(block.hidden, false, "back on the survey, it is the first thing to read");
});

test("a focus that survived the clamp hides the block, remembered or not", () => {
  // `onFocus` never fires for the state a round opens in, so the mount call is
  // all that gets the first frame right. The call: `main-events.test.ts`; rule: here.
  const opened = { hidden: false };

  showIntentFor(opened, clampFocus(1, 3));

  assert.equal(opened.hidden, true);
});

test("a focus the clamp threw away leaves the block on screen", () => {
  // The clamp reads that index as no focus at all, and the page it draws is
  // the survey — which is where this block belongs.
  const opened = { hidden: false };

  showIntentFor(opened, clampFocus(7, 2));

  assert.equal(opened.hidden, false);
});
