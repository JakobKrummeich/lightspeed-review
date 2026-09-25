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
      code: "feedback_item_unknown",
      message: "no such item: t9 — nothing was posted",
      detail: "items in this review: t1, main",
    },
    help: ["Re-run with ids from the list"],
  });

  const parsed = parseBody(422, body);

  assert.ok(parsed instanceof ReviewError);
  assert.equal(parsed.code, "feedback_item_unknown");
  assert.match(parsed.message, /nothing was posted/);
  assert.equal(parsed.detail, "items in this review: t1, main");
  assert.deepEqual(parsed.suggestions, ["Re-run with ids from the list"]);
});

/** Regression: a code this client did not know about reached the agent as
 * `internal_error`, which reads as a lightspeed bug rather than an illegal move. */
test("a 422 carrying a code this client has never seen is relayed, not swallowed", () => {
  const body = JSON.stringify({
    error: {
      code: "turn_not_yours",
      message: "you do not hold the turn (turn: reviewer)",
      detail: "the turn moves to you on delivery to a blocking `lightspeed wait`",
    },
    help: ["Run `lightspeed wait feature-auth main` to block until the reviewer sends"],
  });

  const parsed = parseBody(422, body);

  assert.ok(parsed instanceof ReviewError);
  assert.equal(parsed.code, "turn_not_yours");
  assert.match(parsed.detail ?? "", /on delivery/);
  assert.deepEqual(parsed.suggestions, [
    "Run `lightspeed wait feature-auth main` to block until the reviewer sends",
  ]);
});

test("a 422 without a readable error is a lightspeed bug, not a silent success", () => {
  for (const body of ["not json", JSON.stringify({ error: { code: "other" } })]) {
    const parsed = parseBody(422, body);
    assert.ok(parsed instanceof ReviewError, body);
    assert.equal(parsed.code, "internal_error", body);
  }
});

/**
 * The long poll resolves whatever this returns that is not a ReviewError, so a
 * 500 read as an answer would end `wait` with the server's crash for feedback.
 */
test("a status outside 2xx is a lightspeed bug even when its body is JSON", () => {
  const body = JSON.stringify({ status: "feedback", prompts: [], trace: "x".repeat(300) });

  for (const status of [500, 302, 400]) {
    const parsed = parseBody(status, body);

    assert.ok(parsed instanceof ReviewError, String(status));
    assert.equal(parsed.code, "internal_error", String(status));
    assert.equal(parsed.message, `the review server answered ${status}`);
    // The body is quoted, not dumped: a stack trace must not flood the agent's turn.
    assert.equal(parsed.detail, body.slice(0, 200));
  }
});

test("a 2xx body that is not JSON is a lightspeed bug, never an answer", () => {
  const body = `<html>${"proxy page ".repeat(30)}</html>`;

  for (const status of [200, 204]) {
    const parsed = parseBody(status, body);

    assert.ok(parsed instanceof ReviewError, String(status));
    assert.equal(parsed.code, "internal_error", String(status));
    assert.match(parsed.message, /not JSON/);
    assert.equal(parsed.detail, body.slice(0, 200));
  }
});

test("nothing listening is still reported as no server, once retried", async () => {
  await assert.rejects(
    () => apiRequest("http://127.0.0.1:1/health"),
    (error: ReviewError) => {
      assert.equal(error.code, "server_not_running");
      assert.match(error.detail ?? "", /nothing accepts a connection on port 1/);
      assert.match(error.suggestions.join(" "), /lightspeed open <branch> \[base\] --intent/);
      return true;
    },
  );
});

/**
 * A fresh `open` exits 2 without `--intent`, so a help line that spells `open` without
 * it costs the turn it was written to save — and the review it names is the one
 * on the command line the agent already typed.
 */
test("every open these failures suggest names this review and carries --intent", () => {
  const about = { key: "abc", target: "feature-auth main" };

  for (const status of [404, 503]) {
    const parsed = parseBody(status, "", about);

    assert.ok(parsed instanceof ReviewError, String(status));
    assert.match(
      parsed.suggestions.join(" "),
      /lightspeed open feature-auth main --intent '<why this branch exists>'/,
      String(status),
    );
  }
});
