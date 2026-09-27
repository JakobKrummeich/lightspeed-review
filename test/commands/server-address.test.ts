import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diagnosePort,
  probePort,
  reviewServerIsUp,
  serverOrigin,
} from "../../src/commands/server-address.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import { freePort, NO_SERVER_PORT, occupyPort } from "../helpers/ports.ts";

/**
 * `diagnosePort` is the liveness verdict four modules trust, so its states are
 * proven against real sockets rather than assumed at every call site.
 */

function reviewServerOn(port: number): ReviewServer {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-address-")));
  return createReviewServer({ store, port });
}

test("serverOrigin is always loopback: the server binds no other address", () => {
  assert.equal(serverOrigin(4388), "http://127.0.0.1:4388");
});

test("probePort tells a listening port from one nothing holds", async () => {
  assert.equal(await probePort(NO_SERVER_PORT), "refused");

  const squatter = await occupyPort();
  try {
    assert.equal(await probePort(squatter.port), "open");
  } finally {
    await squatter.release();
  }
});

test("diagnosePort with no backoff answers with the first probe's state", async () => {
  assert.equal(await diagnosePort(NO_SERVER_PORT, []), "refused");
});

test("diagnosePort believes refused only after the retries also find nothing", async () => {
  // A single refused connection is a moment, not a diagnosis: a server that
  // comes up between probes must flip the verdict to open. freePort, not port
  // 0: the port is probed before anything listens on it.
  const port = await freePort();
  const server = reviewServerOn(port);
  setTimeout(() => void server.start(), 20);
  try {
    assert.equal(await diagnosePort(port, [150, 150]), "open");
  } finally {
    await server.stop();
  }
});

test("diagnosePort returns at the first open probe instead of sitting out the backoff", async () => {
  const squatter = await occupyPort();
  try {
    const begun = Date.now();
    assert.equal(await diagnosePort(squatter.port, [5_000]), "open");
    assert.ok(Date.now() - begun < 2_500, "an open port must not wait the backoff out");
  } finally {
    await squatter.release();
  }
});

test("reviewServerIsUp recognises our server and only our server", async () => {
  assert.equal(await reviewServerIsUp(NO_SERVER_PORT), false);

  const server = reviewServerOn(0);
  const { port } = await server.start();
  try {
    assert.equal(await reviewServerIsUp(port), true);
  } finally {
    await server.stop();
  }
});

test("a process that holds the port without speaking HTTP is not our server", async () => {
  // The bounded /health request is what keeps this from waiting forever.
  const squatter = await occupyPort();
  try {
    assert.equal(await reviewServerIsUp(squatter.port), false);
  } finally {
    await squatter.release();
  }
});
