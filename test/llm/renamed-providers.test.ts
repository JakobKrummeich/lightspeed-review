import { test } from "node:test";
import assert from "node:assert/strict";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  RENAMED_PROVIDERS,
  currentProviderId,
  legacyProviderId,
  renamedProviderHelp,
  withCurrentProviderIds,
} from "../../src/llm/renamed-providers.ts";

/** The map is only true of the pi-ai installed: a rename back, or a new one, fails here first. */
test("every rename maps an id pi-ai no longer ships to one it does", () => {
  const shipped = new Set(builtinProviders().map((provider) => provider.id));
  for (const [legacy, current] of RENAMED_PROVIDERS) {
    assert.ok(shipped.has(current), `${current} is a builtin`);
    assert.ok(!shipped.has(legacy), `${legacy} is not a builtin any more`);
  }
});

test("an old id resolves to the current one, and every other id to itself", () => {
  assert.equal(currentProviderId("azure-openai-responses"), "azure");
  assert.equal(currentProviderId("azure"), "azure");
  assert.equal(currentProviderId("anthropic"), "anthropic");
  assert.equal(currentProviderId("constructor"), "constructor");
});

test("a current id names the old id its credential may sit under", () => {
  assert.equal(legacyProviderId("azure"), "azure-openai-responses");
  assert.equal(legacyProviderId("anthropic"), undefined);
  assert.equal(legacyProviderId("azure-openai-responses"), undefined);
});

test("entries under an old id move to the current id, beside the rest", () => {
  assert.deepEqual(
    withCurrentProviderIds({ "azure-openai-responses": { baseUrl: "a" }, anthropic: {} }),
    { anthropic: {}, azure: { baseUrl: "a" } },
  );
});

test("an entry under the current id beats one under the old id, in either order", () => {
  const current = { baseUrl: "current" };
  const legacy = { baseUrl: "legacy" };

  assert.deepEqual(withCurrentProviderIds({ azure: current, "azure-openai-responses": legacy }), {
    azure: current,
  });
  assert.deepEqual(withCurrentProviderIds({ "azure-openai-responses": legacy, azure: current }), {
    azure: current,
  });
});

test("a config naming no renamed provider gets no help", () => {
  assert.deepEqual(renamedProviderHelp({ model: "anthropic/claude-sonnet-4-5" }), []);
  assert.deepEqual(
    renamedProviderHelp({ model: "azure/gpt-5", providers: { azure: { baseUrl: "u" } } }),
    [],
  );
  assert.deepEqual(renamedProviderHelp({ model: "azure-openai-responses" }), []);
});

test("a model under the old id is told the exact value to write", () => {
  const [line, ...rest] = renamedProviderHelp({ model: "azure-openai-responses/gpt-5" });

  assert.deepEqual(rest, []);
  assert.match(line ?? "", /renamed provider `azure-openai-responses` to `azure`/);
  assert.match(line ?? "", /still works/);
  assert.match(line ?? "", /set `"model": "azure\/gpt-5"` in \.lightspeed\.conf\.json/);
});

test("a provider entry under the old id is told to move to the current key", () => {
  const help = renamedProviderHelp({
    model: "azure/gpt-5",
    providers: { "azure-openai-responses": { baseUrl: "u" } },
  });

  assert.equal(help.length, 1);
  assert.match(help[0] ?? "", /rename `providers\.azure-openai-responses` to `providers\.azure`/);
});

/** Renaming onto a key that exists would be advice the JSON cannot take. */
test("an old entry beside a current one is told to go, not to move", () => {
  const [line] = renamedProviderHelp({
    model: "azure/gpt-5",
    providers: { azure: { baseUrl: "a" }, "azure-openai-responses": { baseUrl: "b" } },
  });

  assert.match(line ?? "", /`providers\.azure` is the one applied/);
  assert.match(line ?? "", /delete `providers\.azure-openai-responses`/);
  assert.doesNotMatch(line ?? "", /still works/);
});

test("model and provider help both appear, model first", () => {
  const help = renamedProviderHelp({
    model: "azure-openai-responses/gpt-5",
    providers: { "azure-openai-responses": { baseUrl: "u" } },
  });

  assert.equal(help.length, 2);
  assert.match(help[0] ?? "", /"model"/);
  assert.match(help[1] ?? "", /providers\./);
});
