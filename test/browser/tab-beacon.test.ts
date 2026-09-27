import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEACON_PREFIX,
  beaconState,
  beaconTitle,
  FAVICON,
  FAVICON_LIT,
} from "../../src/browser/tab-beacon.ts";
import type { Turn } from "../../src/session-store.ts";

const YOURS: Turn = { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" };
const AGENTS: Turn = { holder: "agent", mode: "working", at: "2025-01-01T00:01:00.000Z" };

test("the beacon lights for the reviewer's turn in a hidden tab", () => {
  assert.equal(beaconState(YOURS, true), "lit");
});

test("a visible tab keeps the beacon dark: the page itself says whose turn it is", () => {
  assert.equal(beaconState(YOURS, false), "dark");
});

test("the agent's turn never lights it, looked at or not", () => {
  assert.equal(beaconState(AGENTS, true), "dark");
  assert.equal(beaconState(AGENTS, false), "dark");
});

test("a lit title leads with the news and keeps the page's own title after it", () => {
  assert.equal(
    beaconTitle("feat ← main · lightspeed", "lit"),
    "● Your turn · feat ← main · lightspeed",
  );
  assert.equal(BEACON_PREFIX, "● Your turn · ");
  assert.equal(beaconTitle("feat ← main · lightspeed", "dark"), "feat ← main · lightspeed");
});

test("the favicon is a self-contained SVG, and its two lit frames differ from it and each other", () => {
  const frames = [FAVICON, ...FAVICON_LIT];

  for (const frame of frames) {
    assert.match(frame, /^data:image\/svg\+xml,/);
    // Encoded whole: a raw quote would end the `href` it is written into.
    assert.doesNotMatch(frame, /["<>]/);
    assert.match(decodeURIComponent(frame), /^data:image\/svg\+xml,<svg xmlns=/);
  }
  assert.equal(new Set(frames).size, 3);
});
