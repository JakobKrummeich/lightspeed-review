import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStop } from "../../src/commands/stop.ts";
import { probePort } from "../../src/commands/server-address.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import { freePort } from "../helpers/ports.ts";

function reviewServerOn(port: number): ReviewServer {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-stop-")));
  return createReviewServer({ store, port });
}

/** The socket closes after the shutdown response, so "gone" is a state to await. */
async function untilRefused(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await probePort(port)) === "refused") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`port ${port} still answers after stop`);
}

test("stop takes a running server down and says the sessions survive it", async () => {
  const port = await freePort();
  const server = reviewServerOn(port);
  await server.start();
  try {
    const output = await runStop({ port });

    assert.deepEqual(output.server, { port, status: "stopped" });
    // Stopping the server must not read as losing the reviews it served.
    assert.match(output.message as string, /open sessions stay on disk/);
    assert.ok((output.help as string[]).length > 0);
    await untilRefused(port);
  } finally {
    // A second stop is a no-op when the shutdown already landed.
    await server.stop();
  }
});

test("stopping a server that is not there is success and names the port", async () => {
  const port = await freePort();

  const output = await runStop({ port });

  // The caller asked for a state, not for an event: already stopped is it.
  assert.deepEqual(output.server, { port, status: "not_running" });
  assert.equal(output.message, `no review server was listening on port ${port}`);
  assert.ok((output.help as string[]).length > 0);
});
