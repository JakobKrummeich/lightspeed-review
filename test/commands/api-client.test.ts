import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { apiRequest, jsonPost, parseBody } from "../../src/commands/api-client.ts";
import { ReviewError } from "../../src/errors.ts";

interface Harness {
  url: string;
  /** Requests the server actually answered. */
  served: string[];
  close: () => Promise<void>;
}

/**
 * A server that kills its first `dropped` connections before speaking, which
 * is what a keep-alive socket closed under the client looks like from here.
 */
async function serverDropping(dropped: number): Promise<Harness> {
  const served: string[] = [];
  let toDrop = dropped;
  const server: Server = createServer((request, response) => {
    served.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  server.on("connection", (socket) => {
    if (toDrop <= 0) return;
    toDrop -= 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    served,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

test("a GET whose connection is dropped is retried instead of reported as no server", async () => {
  const harness = await serverDropping(1);

  const body = await apiRequest(`${harness.url}/api/poll?key=abc`);

  assert.deepEqual(body, { ok: true });
  assert.deepEqual(harness.served, ["GET /api/poll?key=abc"]);
  await harness.close();
});

test("a GET is retried only once, and a port that is still open is not called dead", async () => {
  const harness = await serverDropping(5);

  await assert.rejects(
    () => apiRequest(`${harness.url}/api/poll?key=abc`),
    (error: ReviewError) => {
      assert.equal(error.code, "server_unreachable");
      assert.match(error.message, /did not answer the request/);
      // "fetch failed" alone says nothing; what the socket did is on `cause`.
      assert.match(error.detail ?? "", /ECONNRESET|UND_ERR|socket/i);
      return true;
    },
  );
  assert.deepEqual(harness.served, []);
  await harness.close();
});

test("a POST is never retried, so a dropped reply cannot be sent twice", async () => {
  const harness = await serverDropping(1);

  await assert.rejects(
    () => apiRequest(`${harness.url}/api/session/abc/reply`, jsonPost({ comment: "hi" })),
    (error: ReviewError) => error.code === "server_unreachable",
  );
  assert.deepEqual(harness.served, []);
  await harness.close();
});

test("a 422 relays the server's own structured error, help and all", () => {
  const body = JSON.stringify({
    error: {
      code: "declaration_invalid",
      message: "the reply was rejected whole: 1 declaration problem(s)",
      detail: "evt_a: declares nothing",
    },
    help: ["Ids come from the annotations in `lightspeed poll` output"],
  });

  const parsed = parseBody(422, body);

  assert.ok(parsed instanceof ReviewError);
  assert.equal(parsed.code, "declaration_invalid");
  assert.match(parsed.message, /rejected whole/);
  assert.equal(parsed.detail, "evt_a: declares nothing");
  assert.deepEqual(parsed.suggestions, [
    "Ids come from the annotations in `lightspeed poll` output",
  ]);
});

test("a 422 without a readable error is a lightspeed bug, not a silent success", () => {
  for (const body of ["not json", JSON.stringify({ error: { code: "other" } })]) {
    const parsed = parseBody(422, body);
    assert.ok(parsed instanceof ReviewError, body);
    assert.equal(parsed.code, "internal_error", body);
  }
});

test("nothing listening is still reported as no server, once retried", async () => {
  await assert.rejects(
    () => apiRequest("http://127.0.0.1:1/health"),
    (error: ReviewError) => {
      assert.equal(error.code, "server_not_running");
      assert.match(error.detail ?? "", /nothing accepts a connection on port 1/);
      return true;
    },
  );
});
