import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  assertServerSharesState,
  ensureServerRunning,
} from "../../src/commands/server-lifecycle.ts";
import { CLI_VERSION } from "../../src/version.ts";
import { ReviewError } from "../../src/errors.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import { freePort, NO_SERVER_PORT, occupyPort } from "../helpers/ports.ts";

/** Where every server this file starts keeps its reviews, unless a test says otherwise. */
const STATE_DIR = mkdtempSync(join(tmpdir(), "lsr-lifecycle-"));

function reviewServerOn(port: number, stateDir = STATE_DIR): ReviewServer {
  return createReviewServer({ store: new SessionStore(stateDir), port });
}

/** A review server from an older install: ours by `/health`, and obsolete. Port 0 picks one. */
async function staleServerOn(
  port: number,
  version: string,
): Promise<{ port: number; shutdowns: number; close: () => Promise<void> }> {
  const state = { port, shutdowns: 0, close: async () => undefined as void };
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
  state.port = (server.address() as AddressInfo).port;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

test("a server that is already listening is left alone", async () => {
  const server = reviewServerOn(0);
  const { port } = await server.start();
  let spawns = 0;

  await ensureServerRunning({ port, stateDir: STATE_DIR, spawnServer: () => (spawns += 1) });

  assert.equal(spawns, 0);
  await server.stop();
});

/** freePort, not port 0: the stand-in for the spawn listens on the port `ensureServerRunning` already polls. */
test("starts a background server and waits for it to answer", async () => {
  const port = await freePort();
  let started: ReviewServer | undefined;

  await ensureServerRunning({
    port,
    stateDir: STATE_DIR,
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
/** freePort, not port 0: the replacement binds the port the stale server just released, and it must still be free. */
test("a server of another version is replaced, not talked to", async () => {
  const port = await freePort();
  const stale = await staleServerOn(port, "0.0.1");
  let started: ReviewServer | undefined;

  await ensureServerRunning({
    port,
    stateDir: STATE_DIR,
    spawnServer: () => {
      started = reviewServerOn(port);
      setTimeout(() => void started!.start(), 30);
    },
  });

  assert.equal(stale.shutdowns, 1);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), {
    status: "ok",
    version: CLI_VERSION,
    stateDir: STATE_DIR,
  });
  await started!.stop();
});

/** A server this CLI's own version started is the one case where there is
 * nothing to do — and nothing may be restarted under a review in progress. */
test("a server of this version is left running, review and all", async () => {
  const server = reviewServerOn(0);
  const { port } = await server.start();
  let spawns = 0;

  await ensureServerRunning({ port, stateDir: STATE_DIR, spawnServer: () => (spawns += 1) });

  assert.equal(spawns, 0);
  await server.stop();
});

test("a port held by something that is not a review server fails fast", async () => {
  const squatter = await occupyPort();
  const { port } = squatter;
  let spawns = 0;

  await assert.rejects(
    () => ensureServerRunning({ port, stateDir: STATE_DIR, spawnServer: () => (spawns += 1) }),
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
  const port = NO_SERVER_PORT;
  const staticDir = mkdtempSync(join(tmpdir(), "lsr-lifecycle-static-"));
  let spawns = 0;

  await assert.rejects(
    () =>
      ensureServerRunning({
        port,
        stateDir: STATE_DIR,
        staticDir,
        spawnServer: () => (spawns += 1),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "browser_bundle_missing");
      return true;
    },
  );

  assert.equal(spawns, 0);
});

test("reports the server as unreachable when the spawned process never answers", async () => {
  await assert.rejects(
    () =>
      ensureServerRunning({
        port: NO_SERVER_PORT,
        stateDir: STATE_DIR,
        spawnServer: () => undefined,
        timeoutMs: 80,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_not_running");
      return true;
    },
  );
});

/**
 * Regression: a server started under another HOME answered the same version,
 * was reused, and kept the review where this CLI never looked — so its re-run
 * found no session and was refused `intent_missing` while the reviewer's Send
 * sat in the other directory.
 */
test("a server of this version keeping its reviews elsewhere is refused, naming both and the fix", async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), "lsr-lifecycle-elsewhere-"));
  const server = reviewServerOn(0, elsewhere);
  const { port } = await server.start();
  let spawns = 0;

  await assert.rejects(
    () => ensureServerRunning({ port, stateDir: STATE_DIR, spawnServer: () => (spawns += 1) }),
    (error: unknown) => {
      assert.ok(error instanceof ReviewError);
      assert.equal(error.code, "server_state_mismatch");
      assert.match(
        error.message,
        new RegExp(`keeps its reviews in ${elsewhere}, this CLI in ${STATE_DIR}`),
      );
      assert.match(error.suggestions[0]!, /^Run `lightspeed stop`.*then re-run this command/);
      return true;
    },
  );

  assert.equal(spawns, 0);
  await server.stop();
});

test("asking before a command: a server sharing the state dir, or none at all, passes", async () => {
  await assertServerSharesState(NO_SERVER_PORT, STATE_DIR);
  const server = reviewServerOn(0);
  const { port } = await server.start();

  await assertServerSharesState(port, STATE_DIR);

  await server.stop();
});

test("asking before a command: a server keeping its reviews elsewhere is refused", async () => {
  const server = reviewServerOn(0, mkdtempSync(join(tmpdir(), "lsr-lifecycle-elsewhere-")));
  const { port } = await server.start();

  await assert.rejects(
    () => assertServerSharesState(port, STATE_DIR),
    (error: unknown) => error instanceof ReviewError && error.code === "server_state_mismatch",
  );

  await server.stop();
});

/** Its sessions are its own business: an older server states no directory, and `server_stale` speaks for it. */
test("asking before a command: a server that states no state dir is not refused for it", async () => {
  const stale = await staleServerOn(0, "2.0.0");

  await assertServerSharesState(stale.port, STATE_DIR);

  await stale.close();
});
