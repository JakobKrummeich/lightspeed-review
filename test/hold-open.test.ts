import { test } from "node:test";
import assert from "node:assert/strict";
import { holdSocketOpen, KEEPALIVE_PROBE_MS } from "../src/hold-open.ts";

function recordingSocket() {
  const calls: string[] = [];
  return {
    calls,
    setTimeout: (ms: number) => calls.push(`timeout ${ms}`),
    setKeepAlive: (enable: boolean, delay: number) => calls.push(`keepalive ${enable} ${delay}`),
  };
}

test("a held socket has no idle timeout and keeps proving itself alive", () => {
  const socket = recordingSocket();

  holdSocketOpen(socket);

  assert.deepEqual(socket.calls, ["timeout 0", `keepalive true ${KEEPALIVE_PROBE_MS}`]);
});
