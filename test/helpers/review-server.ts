/**
 * An in-process review server and the HTTP moves both sides make against it,
 * shared by the server's test files.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerStore } from "../../src/ledger/store.ts";
import { sessionKey } from "../../src/paths.ts";
import { createReviewServer, type ReviewServer } from "../../src/server.ts";
import { SessionStore } from "../../src/session-store.ts";
import { agentWorking } from "../../src/turn.ts";

export interface RunningServer {
  server: ReviewServer;
  url: string;
  store: SessionStore;
}

export interface ServerOptions {
  staticDir?: string;
  ledger?: LedgerStore;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-server-")));
  const server = createReviewServer({ store, port: 0, ...options });
  const { url } = await server.start();
  return { server, url, store };
}

export async function withServer(
  body: (running: RunningServer) => Promise<void>,
  options: ServerOptions = {},
): Promise<void> {
  const running = await startServer(options);
  try {
    await body(running);
  } finally {
    await running.server.stop();
  }
}

export const sessionPayload = {
  repoRoot: "/repo",
  branch: "feature-auth",
  base: "main",
  intents: ["replace session cookies with signed tokens"],
  commits: ["sign the tokens"],
  groups: [
    {
      name: "API Handlers",
      rationale: "request handling",
      files: [
        {
          path: "src/api/users.ts",
          status: "modified",
          diff: "index 11ab34c..4c9f88d 100644\n@@ -1 +1 @@\n-old\n+new",
          insertions: 1,
          deletions: 1,
          oversized: false,
        },
      ],
    },
  ],
};

export async function postSession(url: string): Promise<{ key: string; url: string }> {
  const response = await postSessionRaw(url, sessionPayload);
  assert.equal(response.status, 200);
  return (await response.json()) as { key: string; url: string };
}

export function postSessionRaw(url: string, body: unknown): Promise<Response> {
  return postJson(`${url}/api/sessions`, body);
}

/**
 * The next round, the way 3.0 opens one: the agent publishes from a working
 * turn on a HEAD that moved. The turn is written straight onto the record —
 * these tests are about rounds, not about how the turn got there.
 */
export async function publishRound(
  running: RunningServer,
  body: Record<string, unknown> = sessionPayload,
): Promise<Response> {
  const { repoRoot, branch, base } = body as { repoRoot: string; branch: string; base: string };
  const key = sessionKey(repoRoot, branch, base);
  const session = running.store.get(key);
  assert.ok(session, "publish needs a session to publish into");
  running.store.save({ ...session, turn: agentWorking(new Date().toISOString(), "fixes") });
  return await postSessionRaw(running.url, { ...body, verb: "publish" });
}

export const annotation = {
  type: "annotation",
  file: "src/api/users.ts",
  group: "API Handlers",
  selected_text: "+const user = 1;",
  comment: "wrap in a transaction",
};

export async function postFeedback(
  url: string,
  key: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await postJson(`${url}/api/session/${key}/feedback`, body);
  return { status: response.status, json: await response.json() };
}

export function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function postWork(url: string, key: string, body: unknown): Promise<Response> {
  return postJson(`${url}/api/session/${key}/work`, body);
}

export function postReply(url: string, key: string, body: unknown): Promise<Response> {
  return postJson(`${url}/api/session/${key}/reply`, body);
}

export function postDelivered(url: string, key: string, body: unknown): Promise<Response> {
  return postJson(`${url}/api/session/${key}/delivered`, body);
}

/** One poll, answered and left unacknowledged — a waiting command that read the batch and died. */
export async function pollOnce(url: string, key: string): Promise<Record<string, unknown>> {
  const answer = await fetch(`${url}/api/poll?key=${key}`, { signal: AbortSignal.timeout(2_000) });
  return (await answer.json()) as Record<string, unknown>;
}

/** A poll the way a healthy CLI makes one: takes the answer, then acknowledges it. */
export async function pollAndAck(url: string, key: string): Promise<Record<string, unknown>> {
  const payload = await pollOnce(url, key);
  if (typeof payload.delivery === "string") {
    await postDelivered(url, key, { delivery: payload.delivery });
  }
  return payload;
}

export interface OpenStream {
  /**
   * Next matching frame; earlier frames dropped, later ones kept. Frame-by-frame because the
   * server writes several frames in one tick and they arrive as one read.
   */
  until(wanted: RegExp): Promise<string>;
  close(): void;
}

export async function openStream(url: string, key: string, budget = 5_000): Promise<OpenStream> {
  const abort = new AbortController();
  const response = await fetch(`${url}/api/session/${key}/events`, { signal: abort.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let partial = "";

  /** The budget is spent per read, not per stream: a test does slow work between waits. */
  async function readFrames(wanted: RegExp): Promise<void> {
    const deadline = setTimeout(() => abort.abort(), budget);
    try {
      const { done, value } = await reader.read();
      if (done) assert.fail(`the stream ended before it said ${wanted}`);
      const parts = (partial + decoder.decode(value)).split("\n\n");
      partial = parts.pop() ?? "";
      frames.push(...parts);
    } finally {
      clearTimeout(deadline);
    }
  }

  return {
    async until(wanted: RegExp): Promise<string> {
      for (;;) {
        const frame = frames.shift();
        if (frame === undefined) {
          await readFrames(wanted);
          continue;
        }
        if (wanted.test(frame)) return frame;
      }
    },
    close() {
      abort.abort();
    },
  };
}

/** Catches a hang rather than measuring latency. */
export const PARKED_POLL_LIMIT_MS = 30_000;

/**
 * `until(/"waiting":true/)` on this is a poll parking. Opened before the polls
 * it is asked about, and primed by dropping the frame every new watcher is handed.
 */
export async function parkWatch(url: string, key: string): Promise<OpenStream> {
  const stream = await openStream(url, key);
  await stream.until(/event: presence/);
  return stream;
}

/** A poll that has parked, answered by whatever the test does next. */
export async function parkedFetch(
  url: string,
  key: string,
): Promise<{ answer: Promise<Response> }> {
  const parks = await parkWatch(url, key);
  const polling = fetch(`${url}/api/poll?key=${key}`, {
    signal: AbortSignal.timeout(PARKED_POLL_LIMIT_MS),
  });
  await parks.until(/"waiting":true/);
  parks.close();
  // Wrapped: an async function returning the bare promise would wait for the answer itself.
  return { answer: polling };
}

/**
 * A poll parked on a connection the test can kill without telling the server,
 * as a dying agent connection does.
 */
export async function parkedPoll(
  url: string,
  key: string,
  parked: () => Promise<unknown>,
): Promise<{ kill: () => void; answer: Promise<string> }> {
  const target = new URL(`${url}/api/poll?key=${key}`);
  const request = httpRequest({
    host: target.hostname,
    port: target.port,
    path: `${target.pathname}${target.search}`,
    agent: false,
  });
  const answer = new Promise<string>((resolve) => {
    request.on("response", (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => (body += chunk.toString()));
      response.on("end", () => resolve(body));
      response.on("error", () => resolve(body));
    });
  });
  // Killing the request is the point of it: the hang-up is expected, not a fault.
  request.on("error", () => undefined);
  request.end();
  await parked();
  return { kill: () => request.destroy(), answer };
}

/**
 * A client that asks for the feedback and throws the answer away: it never reads
 * the socket and destroys it, which is what an agent killed mid-delivery does.
 * Nothing on the server's side can tell this from an agent that read every word
 * — measured, `writableFinished`, the `end()` callback and `socket.bytesWritten`
 * are identical for both — which is why a delivery is not safe until the agent
 * says it arrived.
 */
export async function deliverIntoTheVoid(url: string, key: string): Promise<void> {
  const target = new URL(url);
  await new Promise<void>((resolve) => {
    const socket = connect(Number(target.port), target.hostname, () => {
      socket.write(
        `GET /api/poll?key=${key} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`,
      );
      socket.pause();
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 120);
    });
    socket.on("error", () => resolve());
  });
}
