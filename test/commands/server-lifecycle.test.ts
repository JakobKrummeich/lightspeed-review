import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureServerRunning } from "../../src/commands/server-lifecycle.ts";
import { ReviewError } from "../../src/errors.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import { freePort, occupyPort } from "../helpers/ports.ts";

function reviewServerOn(port: number): ReviewServer {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-lifecycle-")));
  return createReviewServer({ store, port });
}

test("a server that is already listening is left alone", async () => {
  const port = await freePort();
  const server = reviewServerOn(port);
  await server.start();
  let spawns = 0;

  await ensureServerRunning({ port, spawnServer: () => (spawns += 1) });

  assert.equal(spawns, 0);
  await server.stop();
});

test("starts a background server and waits for it to answer", async () => {
  const port = await freePort();
  let started: ReviewServer | undefined;

  await ensureServerRunning({
    port,
    spawnServer: () => {
      started = reviewServerOn(port);
      setTimeout(() => void started!.start(), 30);
    },
  });

  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  await started!.stop();
});

test("a port held by something that is not a review server fails fast", async () => {
  const port = await freePort();
  const squatter = await occupyPort(port);
  let spawns = 0;

  await assert.rejects(
    () => ensureServerRunning({ port, spawnServer: () => (spawns += 1) }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "port_unavailable");
      return true;
    },
  );

  assert.equal(spawns, 0);
  await squatter.release();
});

/**
 * The detached server has no stdio anyone reads, so a bundle it cannot serve
 * has to be caught before the spawn or it arrives as a ten-second timeout.
 */
test("a missing browser bundle is reported before anything is spawned", async () => {
  const port = await freePort();
  const staticDir = mkdtempSync(join(tmpdir(), "lsr-lifecycle-static-"));
  let spawns = 0;

  await assert.rejects(
    () => ensureServerRunning({ port, staticDir, spawnServer: () => (spawns += 1) }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "browser_bundle_missing");
      return true;
    },
  );

  assert.equal(spawns, 0);
});

test("reports the server as unreachable when the spawned process never answers", async () => {
  const port = await freePort();

  await assert.rejects(
    () => ensureServerRunning({ port, spawnServer: () => undefined, timeoutMs: 80 }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_not_running");
      return true;
    },
  );
});
