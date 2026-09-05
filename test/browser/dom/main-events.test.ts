import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * main.ts cannot be imported (pulls stylesheets, opens an EventSource, runs itself), so the
 * wiring is checked against the source. Two files read as one: boundaries are length, not behaviour.
 */
const serverDir = new URL("../../../src/server/", import.meta.url);
const page = ["main.ts", "session-events.ts"]
  .map((file) => readFileSync(new URL(`../../../src/browser/dom/${file}`, import.meta.url), "utf8"))
  .join("\n");

/** Every event name the server pushes down a session's stream. */
function published(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(serverDir)) {
    const source = readFileSync(new URL(file, serverDir), "utf8");
    for (const [, event] of source.matchAll(/transport\.publish\([^,]+,\s*"([\w-]+)"/g))
      names.add(event!);
    for (const [, event] of source.matchAll(/sseFrame\("([\w-]+)"/g)) names.add(event!);
  }
  return names;
}

test("every event the server pushes down the stream is one the page listens for", () => {
  // Regression: the server published feedback and nothing on the page heard it — an unheard
  // event just leaves the page stale.
  const heard = new Set(
    [...page.matchAll(/events\.addEventListener\("([\w-]+)"/g)].map(([, event]) => event!),
  );
  const sent = published();

  // Named in full: a scan that quietly stopped matching would otherwise pass by finding nothing.
  assert.deepEqual([...sent].sort(), ["feedback", "presence", "session"]);
  assert.deepEqual(
    [...sent].filter((event) => !heard.has(event)),
    [],
  );
});

test("a presence frame reaches both places the page says who is on the review", () => {
  // One frame, two consumers (banner and panel): telling only the banner was the complaint —
  // the fact hid in a corner.
  const listener = /addEventListener\("presence"[\s\S]*?\n {2}\}\);/.exec(page)?.[0] ?? "";

  assert.ok(listener, "expected the presence listener to be found");
  assert.match(listener, /banner\.setPresence\(/);
  assert.match(listener, /panel\.setWorking\(/);
});

test("a round that lands mid-read waits behind the offer instead of taking the page", () => {
  // Regression: a round landing mid-read threw the reviewer to the top of a re-cut diff.
  // `holdsRound` is tested where it lives; here only that the page asks at all.
  const listener = /addEventListener\("session"[\s\S]*?\n {2}\}\);/.exec(page)?.[0] ?? "";

  assert.ok(listener, "expected the session listener to be found");
  assert.ok(
    listener.indexOf("waits(") < listener.indexOf("applyRound("),
    "the question is asked before the round is applied, not after it",
  );
  assert.match(listener, /offer\.offer\(fresh\)/);
  assert.match(listener, /popup\.offer\(fresh\)/, "the arrival is announced, not only offered");
  // The only other paths onto the screen: both end in the same call, each clearing the other
  // first, so no card or offer outlives an applied round.
  assert.match(page, /popup\.clear\(\);\s*applyRound\(wired, taken\)/);
  assert.match(page, /offer\.clear\(\);\s*applyRound\(wired, taken\)/);
  // Waving the card away is what sets the header's offer calling for the press.
  assert.match(page, /onDismissed: \(\) => offer\.beckon\(\)/);
});

test("the intent block is told about every move between the survey and a chapter", () => {
  // `showIntentFor` is tested where it lives; here only that the page calls it on all three
  // moves: opening on a remembered chapter, entering/leaving one, and a re-group.
  const calls = page.split("\n").filter((line) => line.includes("showIntentFor("));

  assert.equal(calls.length, 3);
  // The focus the diff view will draw, not the remembered one: a lost chapter opens as the survey.
  assert.match(page, /focus: clampFocus\(place\?\.focus, session\.groups\.length\)/);
  // The third call is the re-group's, inside openRound — the only path that runs it.
  assert.match(page, /function openRound\([\s\S]*?showIntentFor\([^)]*undefined\)/);
});

test("the wrapper opens on the gate's word, and is written down the moment it is up", () => {
  // `opensFor` is tested where it lives; here only that the page asks before mounting —
  // unasked, every round would be wrapped.
  const wiring = /function wireOpening\([\s\S]*?\n\}/.exec(page)?.[0] ?? "";

  assert.ok(wiring, "expected the opening's wiring to be found");
  assert.ok(
    wiring.indexOf("opensFor(") < wiring.indexOf("mountOpening("),
    "the gate is asked before the stack goes up, not after it",
  );
  // Written as it opens, not closes: a mid-stack reload must land on the review, not restart the ceremony.
  const flagged = page.split("\n").filter((line) => line.includes("unwrapped: true"));
  assert.equal(flagged.length, 1, "one place writes the flag");
  assert.match(flagged[0] ?? "", /onOpen/);
  assert.equal(
    page.split("\n").filter((line) => line.includes("wireOpening(")).length,
    2,
    "the wiring is defined once and reached once",
  );
});
