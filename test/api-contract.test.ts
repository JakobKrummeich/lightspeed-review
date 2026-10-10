/**
 * The compiler holds each side of the CLI-server contract to `CliRoutes`; this
 * checks the one link it cannot see: that each contract key, split by
 * `routeParts`, is a route the real router matches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeParts, type CliRoute } from "../src/api-contract.ts";
import { createReviewServer } from "../src/server.ts";
import { SessionStore } from "../src/session-store.ts";

/** Every contract route, in request order: shutdown last, because it stops the server. */
const EVERY_ROUTE: { [R in CliRoute]: true } = {
  "POST /api/session/:key/work": true,
  "POST /api/session/:key/reply": true,
  "POST /api/session/:key/end": true,
};

test("every contract route reaches a handler on the real server", async () => {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-contract-")));
  const server = createReviewServer({ store, port: 0 });
  const { port } = await server.start();
  try {
    const unrouted: string[] = [];
    for (const route of Object.keys(EVERY_ROUTE) as CliRoute[]) {
      const { method, pattern } = routeParts(route);
      const url = `http://127.0.0.1:${port}${pattern.replace(":key", "no-such-session")}`;
      const body = (await (await fetch(url, { method })).json()) as { error?: { code?: string } };
      // A handler may refuse (no session, no body); only the router says not_found.
      if (body.error?.code === "not_found") unrouted.push(route);
    }
    assert.deepEqual(unrouted, []);
  } finally {
    await server.stop();
  }
});

test("routeParts splits a contract key into the method and the pattern the router matches", () => {
  assert.deepEqual(routeParts("POST /api/session/:key/work"), {
    method: "POST",
    pattern: "/api/session/:key/work",
  });
});
