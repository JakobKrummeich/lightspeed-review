import { test } from "node:test";
import assert from "node:assert/strict";
import { readPresence } from "../../src/browser/agent-presence.ts";

test("reads both halves of a presence frame", () => {
  assert.deepEqual(readPresence(`{"waiting":true,"working":false}`), {
    waiting: true,
    working: false,
  });
  assert.deepEqual(readPresence(`{"waiting":false,"working":true}`), {
    waiting: false,
    working: true,
  });
});

test("anything but an explicit true is read as nobody there", () => {
  // The frame is text off a socket: a truthy-looking value read as presence
  // would tell the reviewer somebody is listening when nobody is.
  for (const data of [
    `{"waiting":"true","working":"true"}`,
    `{"waiting":1,"working":1}`,
    `{}`,
    `null`,
    `not json at all`,
  ]) {
    assert.deepEqual(readPresence(data), { waiting: false, working: false }, data);
  }
});

test("a frame from a server that knows nothing of working still says who waits", () => {
  // Old server, new page: the field is simply absent, which is not a claim
  // that no agent is working — but it is the only safe reading of one.
  assert.deepEqual(readPresence(`{"waiting":true}`), { waiting: true, working: false });
});
