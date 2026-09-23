import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { ensureServerRunning } from "../../src/commands/server-lifecycle.ts";
import { CLI_VERSION } from "../../src/version.ts";
import { ReviewError } from "../../src/errors.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import { freePort, occupyPort } from "../helpers/ports.ts";

function reviewServerOn(port: number): ReviewServer {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-lifecycle-")));
  return createReviewServer({ store, port });
}

/** A review server from an older install: ours by `/health`, and obsolete. */
async function staleServerOn(
  port: number,
  version: string,
): Promise<{ shutdowns: number; close: () => Promise<void> }> {
  const state = { shutdowns: 0, close: async () => undefined as void };
  const server = createHttpServer((request, response) => {
    if (request.url === "/api/shutdown") {
      state.shutdowns += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "stopping" }));
      response.on("finish", () => server.close());
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", version }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
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

/**
 * "A review server is listening" is not the question. `start` owns the spawn,
 * so `start` clears it: shut the old one down and put this version in its place.
 */
test("a server of another version is replaced, not talked to", async () => {
  const port = await freePort();
  const stale = await staleServerOn(port, "0.0.1");
  let started: ReviewServer | undefined;

  await ensureServerRunning({
    port,
    spawnServer: () => {
      started = reviewServerOn(port);
      setTimeout(() => void started!.start(), 30);
    },
  });

  assert.equal(stale.shutdowns, 1);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), {
    status: "ok",
    version: CLI_VERSION,
  });
  await started!.stop();
});

/** A server this CLI's own version started is the one case where there is
 * nothing to do — and nothing may be restarted under a review in progress. */
test("a server of this version is left running, review and all", async () => {
  const port = await freePort();
  const server = reviewServerOn(port);
  await server.start();
  let spawns = 0;

  await ensureServerRunning({ port, spawnServer: () => (spawns += 1) });

  assert.equal(spawns, 0);
  await server.stop();
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
