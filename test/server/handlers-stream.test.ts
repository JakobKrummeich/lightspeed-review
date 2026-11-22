import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdSource } from "../../src/ledger/records.ts";
import { sessionKey } from "../../src/paths.ts";
import type { ServerContext } from "../../src/server/context.ts";
import { handlePoll } from "../../src/server/handlers-stream.ts";
import { SessionTransport } from "../../src/server/streams.ts";
import { SessionStore } from "../../src/session-store.ts";
import type { FeedbackPrompt, SessionRecord } from "../../src/session-types.ts";

const KEY = sessionKey("/repo", "feature-auth", "main");
const SEND: FeedbackPrompt = { type: "message", id: "t1", comment: "rename this" };

function session(): SessionRecord {
  return {
    key: KEY,
    repoRoot: "/repo",
    branch: "feature-auth",
    base: "main",
    status: "open",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    groups: [],
    conversation: [],
    pending: [],
    approved: [],
    rounds: [],
    turn: { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" },
  };
}

/** Only what `handlePoll` touches: the store, the transport, ids and the URL. */
function pollContext(store: SessionStore): ServerContext {
  return {
    store,
    transport: new SessionTransport(() => undefined),
    nextId: createIdSource(),
    requestUrl: (request: IncomingMessage) => new URL(request.url ?? "/", "http://127.0.0.1"),
  } as Partial<ServerContext> as ServerContext;
}

function pollRequest(): IncomingMessage {
  const socket = { setTimeout: () => socket, setKeepAlive: () => socket };
  return Object.assign(new EventEmitter(), {
    url: `/api/poll?key=${KEY}`,
    socket,
  }) as unknown as IncomingMessage;
}

/** `destroyed` is flipped by the test: a connection gone before its `close` event ran. */
function pollResponse() {
  const socket = { destroyed: false };
  const sent: string[] = [];
  const response = {
    socket,
    writeHead: () => response,
    end: (body: string) => void sent.push(body),
  };
  return { response: response as unknown as ServerResponse, socket, sent };
}

/**
 * The window between a waiting command's connection dying and its `close`
 * handler unparking it: a Send that lands there wakes a poller nobody reads.
 * Drained onto that socket, the batch would flip the turn to an agent that is
 * not there and lock the reviewer out until some agent re-ran its wait.
 */
test("a Send that wakes a poller whose connection died stays queued for the next wait", () => {
  const store = new SessionStore(mkdtempSync(join(tmpdir(), "lsr-stream-")));
  store.save(session());
  const context = pollContext(store);
  const dead = pollResponse();
  handlePoll(context, pollRequest(), dead.response);
  assert.equal(context.transport.isWaiting(KEY), true, "the first wait parks");

  dead.socket.destroyed = true;
  store.save({ ...session(), pending: [SEND] });
  context.transport.wakePollers(KEY);

  assert.deepEqual(dead.sent, [], "nothing is written to a socket that is gone");
  assert.deepEqual(store.get(KEY)?.pending, [SEND]);
  assert.equal(store.get(KEY)?.batch, undefined);
  assert.equal(store.get(KEY)?.turn.holder, "reviewer");

  const live = pollResponse();
  handlePoll(context, pollRequest(), live.response);

  assert.equal(live.sent.length, 1, "the next wait is answered on arrival");
  assert.deepEqual(store.get(KEY)?.batch?.prompts, [SEND]);
  assert.equal(store.get(KEY)?.turn.holder, "agent");
});
