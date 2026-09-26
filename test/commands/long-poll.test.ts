import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { apiRequest, jsonPost } from "../../src/commands/api-client.ts";
import { longPoll } from "../../src/commands/long-poll.ts";
import type { ReviewError } from "../../src/errors.ts";

interface PollRequest {
  url: string;
  /** Which connection carried it: the poll must never reuse a pooled one. */
  socket: number;
  connection: string | undefined;
}

interface Harness {
  port: number;
  /** Poll requests the server saw, dropped ones included. */
  polls: PollRequest[];
  /** Every POST the server saw, as `<url> <body>`: the delivery acknowledgements. */
  posts: string[];
  answer: (status: number, body: string) => void;
  close: () => Promise<void>;
}

interface HarnessOptions {
  /** Kill this many poll requests before answering any — a connection dying. */
  dropped?: number;
  /** Whether `/health` answers, i.e. whether this looks like a review server. */
  healthy?: boolean;
  /** Node's own idle keep-alive, short enough to expire between requests. */
  keepAliveTimeoutMs?: number;
  /** The status every POST is answered with; 200 unless a test says otherwise. */
  postStatus?: number;
}

async function pollServer(options: HarnessOptions = {}): Promise<Harness> {
  const polls: PollRequest[] = [];
  const posts: string[] = [];
  const waiting = new Set<ServerResponse>();
  const sockets = new Map<unknown, number>();
  let toDrop = options.dropped ?? 0;
  const server: Server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(options.healthy === false ? 500 : 200).end("{}");
      return;
    }
    if (request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (body += chunk));
      request.on("end", () => {
        posts.push(`${request.url} ${body}`);
        response
          .writeHead(options.postStatus ?? 200, { "content-type": "application/json" })
          .end("{}");
      });
      return;
    }
    if (!sockets.has(request.socket)) sockets.set(request.socket, sockets.size);
    polls.push({
      url: request.url ?? "",
      socket: sockets.get(request.socket)!,
      connection: request.headers.connection,
    });
    if (toDrop > 0) {
      toDrop -= 1;
      request.socket.destroy();
      return;
    }
    waiting.add(response);
    request.on("close", () => waiting.delete(response));
  });
  if (options.keepAliveTimeoutMs !== undefined)
    server.keepAliveTimeout = options.keepAliveTimeoutMs;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    port,
    polls,
    posts,
    answer: (status, body) => {
      for (const response of waiting) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body);
      }
      waiting.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function pollFor(harness: Harness): Promise<unknown> {
  return longPoll({
    origin: `http://127.0.0.1:${harness.port}`,
    key: "abc",
    port: harness.port,
    probeBackoffMs: [5, 5],
    reconnectDelayMs: 5,
  });
}

async function untilPolled(harness: Harness, count: number): Promise<void> {
  for (let waited = 0; waited < 2_000 && harness.polls.length < count; waited += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    harness.polls.length >= count,
    `expected at least ${count} poll requests, saw ${harness.polls.length}`,
  );
}

test("a poll whose connection is dropped reconnects instead of returning", async () => {
  const harness = await pollServer({ dropped: 1 });

  const polling = pollFor(harness);
  await untilPolled(harness, 2);
  harness.answer(200, JSON.stringify({ status: "feedback", ended: false, prompts: [] }));

  assert.deepEqual(await polling, { status: "feedback", ended: false, prompts: [] });
  await harness.close();
});

test("reconnection is unbounded while the server is still answering for itself", async () => {
  // Far more drops than any retry budget: a server that is demonstrably there
  // is waited on for as long as it takes, never a fixed number of tries.
  const harness = await pollServer({ dropped: 8 });

  const polling = pollFor(harness);
  await untilPolled(harness, 9);
  harness.answer(200, JSON.stringify({ ended: true }));

  assert.deepEqual(await polling, { ended: true });
  await harness.close();
});

test("a reply and then a poll: the wait gets its own connection and survives", async () => {
  // The bug report's sequence — a `say` posts, then a `wait` blocks — against a server whose
  // idle keep-alive expires between the two: the poll takes its own connection and holds it.
  const harness = await pollServer({ keepAliveTimeoutMs: 50 });
  await apiRequest(`http://127.0.0.1:${harness.port}/api/session/abc/reply`, jsonPost({ c: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const polling = pollFor(harness);
  await untilPolled(harness, 1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  harness.answer(200, JSON.stringify({ ended: false, prompts: [] }));

  assert.deepEqual(await polling, { ended: false, prompts: [] });
  assert.deepEqual(harness.polls, [{ url: "/api/poll?key=abc", socket: 0, connection: "close" }]);
  await harness.close();
});

test("the reviewer's own answers end the poll at once, without a retry", async () => {
  const harness = await pollServer();

  const polling = pollFor(harness);
  await untilPolled(harness, 1);
  harness.answer(404, JSON.stringify({ error: { code: "session_not_found" } }));

  await assert.rejects(
    () => polling,
    (error: ReviewError) => error.code === "session_not_found",
  );
  assert.equal(harness.polls.length, 1);
  await harness.close();
});

/** A server that answered is there: reconnecting after its 500 would repeat the
 * crash forever, and returning the body would hand it to the agent as feedback. */
test("a server error ends the poll at once as a lightspeed bug, not as feedback", async () => {
  const harness = await pollServer();

  const polling = pollFor(harness);
  await untilPolled(harness, 1);
  harness.answer(500, JSON.stringify({ status: "feedback", prompts: [] }));

  await assert.rejects(
    () => polling,
    (error: ReviewError) => error.code === "internal_error",
  );
  assert.equal(harness.polls.length, 1);
  await harness.close();
});

/**
 * The prompts are in this process's hands before the acknowledgement goes out: a
 * refused acknowledgement costs one re-delivery on the next poll, while a failed
 * wait would cost the agent the feedback it is holding. A 500 is the sharpest
 * case, because it arrives as a ReviewError — the kind `longPoll` treats as final.
 */
test("a delivery the server fails to confirm still hands the answer back", async (t) => {
  const harness = await pollServer({ postStatus: 500 });
  // Closed even when an assertion fails, so a regression fails instead of hanging.
  t.after(() => harness.close());

  const polling = pollFor(harness);
  await untilPolled(harness, 1);
  harness.answer(200, JSON.stringify({ status: "feedback", prompts: [], delivery: "d-1" }));

  assert.deepEqual(await polling, { status: "feedback", prompts: [], delivery: "d-1" });
  assert.deepEqual(harness.posts, ['/api/session/abc/delivered {"delivery":"d-1"}']);
  assert.equal(harness.polls.length, 1);
});

test("nothing listening is reported as server_not_running once the probes are spent", async () => {
  // Port 1 is privileged and never listening in the test environment.
  await assert.rejects(
    () =>
      longPoll({
        origin: "http://127.0.0.1:1",
        key: "abc",
        target: "feature-auth main",
        port: 1,
        probeBackoffMs: [5, 5],
      }),
    (error: ReviewError) => {
      assert.equal(error.code, "server_not_running");
      assert.match(error.detail ?? "", /nothing accepted a connection on port 1/);
      // The review is the one the wait was already pointed at, and `start`
      // refuses to run without the intent this line now carries.
      assert.match(
        error.suggestions.join(" "),
        /lightspeed start feature-auth main --intent "<why this branch exists>"/,
      );
      return true;
    },
  );
});

test("a port held by something that is not a review server is named, not waited on", async () => {
  // A squatter that accepts connections and closes them would otherwise be an
  // endless silent reconnect loop: the port is open, so the poll keeps trying.
  const squatter = createSocketServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
  const { port } = squatter.address() as { port: number };

  await assert.rejects(
    () =>
      longPoll({
        origin: `http://127.0.0.1:${port}`,
        key: "abc",
        port,
        probeBackoffMs: [5, 5],
        reconnectDelayMs: 5,
      }),
    (error: ReviewError) => {
      assert.equal(error.code, "server_unreachable");
      assert.match(error.message, /is held by something that is not a review server/);
      return true;
    },
  );

  await new Promise<void>((resolve) => squatter.close(() => resolve()));
});

test("a server that keeps dropping polls and stops answering /health is given up on", async () => {
  const harness = await pollServer({ dropped: 20, healthy: false });

  await assert.rejects(
    () => pollFor(harness),
    (error: ReviewError) => {
      assert.equal(error.code, "server_unreachable");
      return true;
    },
  );
  // Given up after the health check, not after one drop.
  assert.ok(harness.polls.length >= 3, `polled ${harness.polls.length} times`);
  await harness.close();
});

test("a server that goes away mid-poll is reported once it stops accepting", async () => {
  const harness = await pollServer();

  const polling = pollFor(harness);
  await untilPolled(harness, 1);
  await harness.close();

  await assert.rejects(
    () => polling,
    (error: ReviewError) => error.code === "server_not_running",
  );
});
