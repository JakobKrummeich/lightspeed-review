import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { hostIsAllowed, originIsAllowed } from "../../src/server/security.ts";

/**
 * The two checks every request passes before the router. `test/server.test.ts`
 * proves the gate is wired in front of the API with one foreign Host and one
 * foreign Origin; this file pins the edges a "simplification" of either check
 * would quietly open. A forged POST lands in the agent's prompt stream, so a
 * regression here is a prompt-injection hole, not a cosmetic one.
 */

const PORT = 4388;

function requestWith(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

test("the Host check serves only a name for this loopback server", () => {
  assert.equal(hostIsAllowed(requestWith({ host: `127.0.0.1:${PORT}` })), true);
  assert.equal(hostIsAllowed(requestWith({ host: `localhost:${PORT}` })), true);

  assert.equal(hostIsAllowed(requestWith({ host: `evil.example.com:${PORT}` })), false);
  // DNS rebinding with a name that merely starts like loopback.
  assert.equal(hostIsAllowed(requestWith({ host: `127.0.0.1.evil.example.com:${PORT}` })), false);
  // HTTP/1.0 may omit Host; with nothing to check, nothing is served.
  assert.equal(hostIsAllowed(requestWith({})), false);
});

test("no Origin is the CLI, and the review page's own origin is the browser", () => {
  assert.equal(originIsAllowed(requestWith({}), PORT), true);
  assert.equal(originIsAllowed(requestWith({ origin: `http://127.0.0.1:${PORT}` }), PORT), true);
  assert.equal(originIsAllowed(requestWith({ origin: `http://localhost:${PORT}` }), PORT), true);
});

test("an Origin that is loopback but not this server's port is refused", () => {
  // Any dev server on this machine — or a page it proxies — is loopback too.
  // Dropping the port comparison would let it forge feedback into the review.
  assert.equal(originIsAllowed(requestWith({ origin: "http://127.0.0.1:3000" }), PORT), false);
  assert.equal(originIsAllowed(requestWith({ origin: "http://localhost:3000" }), PORT), false);
});

test("an opaque or malformed Origin is refused, not waved through as the CLI", () => {
  // Sandboxed iframes, file:// pages and some redirects send the literal
  // `null`. It is present, so it is a browser — and it names no origin to trust.
  assert.equal(originIsAllowed(requestWith({ origin: "null" }), PORT), false);
  assert.equal(originIsAllowed(requestWith({ origin: "not a url" }), PORT), false);
  assert.equal(originIsAllowed(requestWith({ origin: "http://evil.example.com" }), PORT), false);
});
