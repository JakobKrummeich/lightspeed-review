import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRoute, type Route } from "../src/router.ts";

const noop = () => {};

const routes: Route[] = [
  { method: "GET", pattern: "/health", handler: noop },
  { method: "GET", pattern: "/session/:key", handler: noop },
  { method: "GET", pattern: "/api/session/:key/data", handler: noop },
  { method: "POST", pattern: "/api/sessions", handler: noop },
];

test("matches a literal path", () => {
  assert.deepEqual(matchRoute(routes, "GET", "/health")?.params, {});
});

test("captures a named parameter", () => {
  assert.deepEqual(matchRoute(routes, "GET", "/session/a3f8c21b")?.params, { key: "a3f8c21b" });
});

test("captures a parameter in the middle of a path", () => {
  assert.deepEqual(matchRoute(routes, "GET", "/api/session/abc/data")?.params, { key: "abc" });
});

test("decodes percent-encoded parameters", () => {
  assert.deepEqual(matchRoute(routes, "GET", "/session/a%2Fb")?.params, { key: "a/b" });
});

test("does not match a different method", () => {
  assert.equal(matchRoute(routes, "POST", "/health"), undefined);
});

test("does not match a longer path", () => {
  assert.equal(matchRoute(routes, "GET", "/session/abc/extra"), undefined);
});

test("does not match a shorter path", () => {
  assert.equal(matchRoute(routes, "GET", "/session"), undefined);
});

test("does not match an unknown path", () => {
  assert.equal(matchRoute(routes, "GET", "/nope"), undefined);
});

test("returns the handler that was registered", () => {
  const handler = () => {};
  assert.equal(
    matchRoute([{ method: "GET", pattern: "/x", handler }], "GET", "/x")?.handler,
    handler,
  );
});

test("an empty parameter segment does not match", () => {
  assert.equal(matchRoute(routes, "GET", "/session/"), undefined);
});
