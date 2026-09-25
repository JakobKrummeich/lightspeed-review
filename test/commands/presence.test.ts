import { test } from "node:test";
import assert from "node:assert/strict";
import { listening } from "../../src/commands/presence.ts";
import { freePort } from "../helpers/ports.ts";
import { parkedFetch, postSession, withServer } from "../helpers/review-server.ts";

function portOf(url: string): number {
  return Number(new URL(url).port);
}

/** Only the server can tell a waiting command from none: the store knows turns, not sockets. */
test("a session is listened to only while a waiting command is parked on it", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    assert.equal(await listening(portOf(url), key), false);

    await parkedFetch(url, key);

    assert.equal(await listening(portOf(url), key), true);
  });
});

test("no server running is nobody listening, answered at once", async () => {
  const started = Date.now();

  assert.equal(await listening(await freePort(), "any-key"), false);
  assert.ok(Date.now() - started < 1_500);
});

test("a session the server does not know is nobody listening", async () => {
  await withServer(async ({ url }) => {
    assert.equal(await listening(portOf(url), "no-such-key"), false);
  });
});
