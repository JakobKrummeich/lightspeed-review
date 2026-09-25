import { test } from "node:test";
import assert from "node:assert/strict";
import { readPresence } from "../../src/browser/agent-presence.ts";

const NOBODY = { waiting: false, turn: { holder: "reviewer", at: "" } };

test("reads the waiter and the turn out of one frame", () => {
  // `working` is a field an older server sent beside the turn; a reader that
  // choked on one it does not know would break on the next field to be retired.
  assert.deepEqual(
    readPresence(`{"waiting":true,"working":false,"turn":{"holder":"reviewer","at":"T0"}}`),
    { waiting: true, turn: { holder: "reviewer", at: "T0" } },
  );
  assert.deepEqual(
    readPresence(
      `{"waiting":false,"turn":{"holder":"agent","mode":"working","at":"T1","note":"rewriting the parser"}}`,
    ),
    {
      waiting: false,
      turn: { holder: "agent", mode: "working", at: "T1", note: "rewriting the parser" },
    },
  );
});

test("anything but an explicit agent turn leaves the turn with the reviewer", () => {
  // The frame is text off a socket, and the turn is what turns Send into Queue: a
  // garbled frame may only ever hand sending back, never hold it on nobody's word.
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

test("a turn with a mode nobody knows still holds sending back", () => {
  // `mode` is presentational: the holder is what gates, so an unreadable mode
  // costs a sentence at the foot of the panel, never the lock itself. It reads
  // as `digesting` — the claim that assumes least about what the agent is doing.
  assert.deepEqual(readPresence(`{"turn":{"holder":"agent","mode":"napping","at":"T2"}}`), {
    waiting: false,
    turn: { holder: "agent", mode: "digesting", at: "T2" },
  });
});

test("a frame from a server that knows nothing of turns still says who waits", () => {
  assert.deepEqual(readPresence(`{"waiting":true}`), {
    waiting: true,
    turn: { holder: "reviewer", at: "" },
  });
});
