import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  layeredCredentialStore,
  lightspeedAuthPath,
  lightspeedAuthStore,
  piAuthPath,
  piAuthStore,
} from "../../src/llm/pi-auth.ts";

function authFile(contents?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "lightspeed-auth-"));
  const path = join(directory, "auth.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

const oauth = { type: "oauth", refresh: "r", access: "a", expires: 1 } as const;

test("the store reads the credential the pi agent wrote", async () => {
  const path = authFile(JSON.stringify({ anthropic: oauth }));

  assert.deepEqual(await piAuthStore(path).read("anthropic"), oauth);
  rmSync(path, { force: true });
});

test("a provider the file has nothing for reads as no credential, so env still applies", async () => {
  const path = authFile(JSON.stringify({ anthropic: oauth }));

  assert.equal(await piAuthStore(path).read("openai"), undefined);
  rmSync(path, { force: true });
});

test("a missing or malformed file is silence, not a crash", async () => {
  assert.equal(await piAuthStore("/nowhere/auth.json").read("anthropic"), undefined);

  const path = authFile("{ not json");
  assert.equal(await piAuthStore(path).read("anthropic"), undefined);
  rmSync(path, { force: true });
});

test("a refreshed token is written back without disturbing other providers", async () => {
  const path = authFile(
    JSON.stringify({ anthropic: oauth, openai: { type: "api_key", key: "k" } }),
  );
  const rotated = { ...oauth, access: "a2", expires: 2 };

  const returned = await piAuthStore(path).modify("anthropic", async () => rotated);

  const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(returned, rotated);
  assert.deepEqual(onDisk.anthropic, rotated);
  assert.deepEqual(onDisk.openai, { type: "api_key", key: "k" }, "the agent's other logins stay");
  assert.equal(statSync(path).mode & 0o777, 0o600, "a secret is not world-readable");
  rmSync(path, { force: true });
});

test("a modify that returns nothing leaves the file alone", async () => {
  const path = authFile(JSON.stringify({ anthropic: oauth }));

  await piAuthStore(path).modify("anthropic", async () => undefined);

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { anthropic: oauth });
  rmSync(path, { force: true });
});

test("deleting drops one provider and keeps the rest", async () => {
  const path = authFile(
    JSON.stringify({ anthropic: oauth, openai: { type: "api_key", key: "k" } }),
  );

  await piAuthStore(path).delete("anthropic");

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
    openai: { type: "api_key", key: "k" },
  });
  rmSync(path, { force: true });
});

test("the default path is the pi agent's own credential file", () => {
  assert.match(piAuthPath(), /\.pi\/agent\/auth\.json$/);
});

test("lightspeed's own credential file lives in the state dir", () => {
  assert.equal(lightspeedAuthPath("/state"), join("/state", "auth.json"));
});

test("the lightspeed store creates the state dir on first write, mode 600", async () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), "lightspeed-auth-")), "never-made");
  assert.equal(existsSync(stateDir), false);

  await lightspeedAuthStore(stateDir).modify("anthropic", async () => oauth);

  const path = lightspeedAuthPath(stateDir);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { anthropic: oauth });
  assert.equal(statSync(path).mode & 0o777, 0o600, "a secret is not world-readable");
});

/** Two file stores in temp dirs, seeded: `own` is lightspeed's, `pi` is pi's. */
function layeredHarness(own: Record<string, unknown>, pi: Record<string, unknown>) {
  const ownPath = authFile(JSON.stringify(own));
  const piPath = authFile(JSON.stringify(pi));
  return {
    ownPath,
    piPath,
    store: layeredCredentialStore(piAuthStore(ownPath), piAuthStore(piPath)),
  };
}

const piKey = { type: "api_key", key: "pi" } as const;
const ownKey = { type: "api_key", key: "own" } as const;

test("layered read prefers the primary store and falls back per provider", async () => {
  const { store } = layeredHarness({ anthropic: ownKey }, { anthropic: piKey, openai: piKey });

  assert.deepEqual(await store.read("anthropic"), ownKey);
  assert.deepEqual(await store.read("openai"), piKey);
  assert.equal(await store.read("mistral"), undefined);
});

test("layered list is the union with the primary winning per provider", async () => {
  const { store } = layeredHarness({ anthropic: oauth }, { anthropic: piKey, openai: piKey });

  const listed = [...(await store.list())].sort((a, b) => a.providerId.localeCompare(b.providerId));
  assert.deepEqual(listed, [
    { providerId: "anthropic", type: "oauth" },
    { providerId: "openai", type: "api_key" },
  ]);
});

test("a refresh lands in the file that holds the credential: the primary", async () => {
  const { store, ownPath, piPath } = layeredHarness({ anthropic: oauth }, { anthropic: piKey });
  const rotated = { ...oauth, access: "a2" };

  await store.modify("anthropic", async () => rotated);

  assert.deepEqual(JSON.parse(readFileSync(ownPath, "utf8")), { anthropic: rotated });
  assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")), { anthropic: piKey });
});

test("a refresh of a credential only pi holds is written back to pi's file", async () => {
  const { store, ownPath, piPath } = layeredHarness({}, { anthropic: oauth });
  const rotated = { ...oauth, access: "a2" };

  await store.modify("anthropic", async () => rotated);

  assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")), { anthropic: rotated });
  assert.deepEqual(JSON.parse(readFileSync(ownPath, "utf8")), {});
});

test("a credential neither store holds lands in the primary", async () => {
  const { store, ownPath, piPath } = layeredHarness({}, {});

  await store.modify("anthropic", async () => oauth);

  assert.deepEqual(JSON.parse(readFileSync(ownPath, "utf8")), { anthropic: oauth });
  assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")), {});
});

test("the modify callback sees the credential of whichever store owns it", async () => {
  const { store } = layeredHarness({}, { anthropic: piKey });
  let seen: unknown;

  await store.modify("anthropic", async (current) => {
    seen = current;
    return undefined;
  });

  assert.deepEqual(seen, piKey);
});

test("layered delete only ever touches the primary, never pi's file", async () => {
  const { store, ownPath, piPath } = layeredHarness(
    { anthropic: ownKey },
    { anthropic: piKey, openai: piKey },
  );

  await store.delete("anthropic");
  await store.delete("openai");

  assert.deepEqual(JSON.parse(readFileSync(ownPath, "utf8")), {});
  assert.deepEqual(JSON.parse(readFileSync(piPath, "utf8")), { anthropic: piKey, openai: piKey });
});
