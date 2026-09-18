import { test } from "node:test";
import assert from "node:assert/strict";
import { readPresence } from "../../src/browser/agent-presence.ts";

const NOBODY = { waiting: false, turn: { holder: "reviewer", at: "" } };

test("reads the waiter and the turn out of one frame", () => {
  assert.deepEqual(
    readPresence(`{"waiting":true,"working":false,"turn":{"holder":"reviewer","at":"T0"}}`),
    { waiting: true, turn: { holder: "reviewer", at: "T0" } },
  );
  assert.deepEqual(
    readPresence(
      `{"waiting":false,"working":true,"turn":{"holder":"agent","mode":"working","at":"T1","note":"rewriting the parser"}}`,
    ),
    {
      waiting: false,
      turn: { holder: "agent", mode: "working", at: "T1", note: "rewriting the parser" },
    },
  );
});

test("anything but an explicit agent turn leaves the turn with the reviewer", () => {
  // The frame is text off a socket, and the turn is what takes Send away: a
  // garbled frame may only ever hand it back, never lock the page on nobody's word.
  for (const data of [
    `{"waiting":"true","turn":"agent"}`,
    `{"waiting":1,"turn":{"holder":"nobody"}}`,
    `{}`,
    `null`,
    `not json at all`,
  ]) {
    assert.deepEqual(readPresence(data), NOBODY, data);
  }
});

test("a turn with a mode nobody knows still locks Send", () => {
  // `mode` is presentational: the holder is what gates, so an unreadable mode
  // costs a sentence at the foot of the panel, never the lock itself. It reads
  // as `reading` — the claim that assumes least about what the agent is doing.
  assert.deepEqual(readPresence(`{"turn":{"holder":"agent","mode":"napping","at":"T2"}}`), {
    waiting: false,
    turn: { holder: "agent", mode: "reading", at: "T2" },
  });
});

test("a frame from a server that knows nothing of turns still says who waits", () => {
  assert.deepEqual(readPresence(`{"waiting":true}`), {
    waiting: true,
    turn: { holder: "reviewer", at: "" },
  });
});
