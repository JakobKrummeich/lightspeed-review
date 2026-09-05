import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogout } from "../../src/commands/logout.ts";
import { lightspeedAuthPath, lightspeedAuthStore } from "../../src/llm/pi-auth.ts";

const oauth = { type: "oauth", refresh: "r", access: "a", expires: 1 } as const;

function tempStateDir(): string {
  return join(mkdtempSync(join(tmpdir(), "lsr-logout-")), "state");
}

test("logout removes the stored credential and keeps every other provider", async () => {
  const stateDir = tempStateDir();
  const store = lightspeedAuthStore(stateDir);
  await store.modify("anthropic", async () => oauth);
  await store.modify("github-copilot", async () => oauth);

  const output = await runLogout({ provider: "anthropic", stateDir });

  assert.deepEqual(output.logout, {
    provider: "anthropic",
    removed: true,
    path: lightspeedAuthPath(stateDir),
  });
  const onDisk = JSON.parse(readFileSync(lightspeedAuthPath(stateDir), "utf8")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(onDisk), ["github-copilot"]);
  assert.ok((output.help as string[]).length > 0);
});

test("logout of a provider with nothing stored reports removed: false", async () => {
  const stateDir = tempStateDir();

  const output = await runLogout({ provider: "anthropic", stateDir });

  assert.deepEqual(output.logout, {
    provider: "anthropic",
    removed: false,
    path: lightspeedAuthPath(stateDir),
  });
});

test("any provider id is accepted: logout is not gated on the login allowlist", async () => {
  const stateDir = tempStateDir();
  const store = lightspeedAuthStore(stateDir);
  await store.modify("mistral", async () => ({ type: "api_key", key: "k" }));

  const output = await runLogout({ provider: "mistral", stateDir });

  assert.deepEqual(output.logout, {
    provider: "mistral",
    removed: true,
    path: lightspeedAuthPath(stateDir),
  });
});
