import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai";
import type {
  ApiKeyCredential,
  AuthResult,
  Credential,
  CredentialStore,
  ModelAuth,
  Models,
  ModelsError,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import type { PiProviderConfig } from "../../src/llm/pi-models.ts";
import { applyPiProviders } from "../../src/llm/providers.ts";
import { ReviewError } from "../../src/errors.ts";

/** A stand-in for a provider pi-ai ships: its key comes from pi's credential store. */
function builtinProvider(headers?: Record<string, string>): Provider {
  return {
    id: "faux",
    name: "faux",
    baseUrl: "https://builtin.example.test",
    auth: {
      apiKey: {
        name: "faux API key",
        resolve: async ({ credential }): Promise<AuthResult | undefined> =>
          credential?.key
            ? {
                auth: { apiKey: credential.key, ...(headers ? { headers } : {}) },
                source: "stored",
              }
            : undefined,
      },
    },
    getModels: () => [],
    stream: () => {
      throw new Error("not used");
    },
    streamSimple: () => {
      throw new Error("not used");
    },
  };
}

/** A store holding one credential, standing in for pi's auth.json. */
function stored(credential: Credential): CredentialStore {
  return {
    read: async () => credential,
    list: async () => [{ providerId: "faux", type: credential.type }],
    modify: async () => credential,
    delete: async () => undefined,
  };
}

function storedKey(key: string): CredentialStore {
  return stored({ type: "api_key", key } satisfies ApiKeyCredential);
}

/**
 * pi-ai wraps whatever `resolve` throws in a `ModelsError` and keeps ours as
 * `cause`, so the sentence the reviewer reads is the cause's, not the wrapper's.
 */
async function authError(models: Models, id: string): Promise<ReviewError> {
  try {
    await models.getAuth(id);
  } catch (error) {
    const cause = (error as ModelsError).cause;
    assert.ok(cause instanceof ReviewError, `expected a ReviewError cause, got ${String(error)}`);
    return cause;
  }
  throw new Error(`expected ${id} auth resolution to fail`);
}

function applyPi(models: MutableModels, config: PiProviderConfig): void {
  applyPiProviders(models, { faux: config });
}

test("a Pi provider entry layers its URL and headers onto a builtin's stored key", async () => {
  const models = createModels({ credentials: storedKey("from-auth-json") });
  models.setProvider(builtinProvider());

  applyPi(models, { baseUrl: "https://gateway.example.test/v1", headers: { "x-pi-route": "r" } });

  const auth = await models.getAuth("faux");
  assert.equal(auth?.auth.apiKey, "from-auth-json");
  assert.equal(auth?.auth.baseUrl, "https://gateway.example.test/v1");
  assert.deepEqual(auth?.auth.headers, { "x-pi-route": "r" });
});

test("a models.json apiKey configures a builtin pi never logged into", async () => {
  const models = createModels();
  models.setProvider(builtinProvider());

  applyPi(models, { baseUrl: "https://gateway.example.test/v1", apiKey: "from-models-json" });

  const auth = await models.getAuth("faux");
  assert.equal(auth?.auth.apiKey, "from-models-json");
  assert.equal(auth?.auth.baseUrl, "https://gateway.example.test/v1");
});

/**
 * "Unconfigured" has to survive the layering: `groupDiff` turns a missing
 * credential into a fatal `pi_auth_missing`, and a provider that reported
 * itself configured with no key would instead read as a failed model call.
 */
test("a builtin with no credential and no models.json key stays unconfigured", async () => {
  const models = createModels();
  models.setProvider(builtinProvider());

  applyPi(models, { baseUrl: "https://gateway.example.test/v1" });

  assert.equal(await models.getAuth("faux"), undefined);
});

test("an OAuth builtin carries the Pi entry's URL and headers too", async () => {
  const credential = {
    type: "oauth" as const,
    refresh: "r",
    access: "a",
    expires: Date.now() + 1e6,
  };
  const models = createModels({ credentials: stored(credential) });
  models.setProvider({
    ...builtinProvider(),
    auth: {
      oauth: {
        name: "faux oauth",
        login: async () => credential,
        refresh: async () => credential,
        toAuth: async (): Promise<ModelAuth> => ({ apiKey: "oauth-token" }),
      },
    },
  });

  applyPi(models, { baseUrl: "https://gateway.example.test/v1", headers: { "x-pi-route": "r" } });

  const auth = await models.getAuth("faux");
  assert.equal(auth?.auth.apiKey, "oauth-token");
  assert.equal(auth?.auth.baseUrl, "https://gateway.example.test/v1");
  assert.deepEqual(auth?.auth.headers, { "x-pi-route": "r" });
});

/** pi-ai merges headers case-insensitively; a merge that does not ships both. */
test("authHeader sends the resolved key as Authorization, however the builtin spelled it", async () => {
  const models = createModels({ credentials: storedKey("stored-key") });
  models.setProvider(builtinProvider({ authorization: "from-builtin", "x-keep": "builtin" }));

  applyPi(models, { authHeader: true });

  const headers = (await models.getAuth("faux"))?.auth.headers ?? {};
  assert.deepEqual(headers, { "x-keep": "builtin", Authorization: "Bearer stored-key" });
});

test("authHeader with no key to send is reported, not sent as `Bearer undefined`", async () => {
  const models = createModels({ credentials: storedKey("stored-key") });
  models.setProvider({
    ...builtinProvider(),
    auth: {
      apiKey: {
        name: "faux API key",
        resolve: async (): Promise<AuthResult> => ({ auth: { headers: { "x-corp": "t" } } }),
      },
    },
  });

  applyPi(models, { authHeader: true });

  const error = await authError(models, "faux");
  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /faux/);
  assert.match(error.message, /authHeader/);
});

test("a models.json value nothing resolves is a config error naming what failed", async () => {
  for (const [named, config] of [
    ["apiKey", { apiKey: "$PI_KEY_NOTHING_SETS" }],
    ["header `x-pi-route`", { apiKey: "k", headers: { "x-pi-route": "$PI_ROUTE_NOTHING_SETS" } }],
  ] satisfies [string, PiProviderConfig][]) {
    const models = createModels();
    models.setProvider(builtinProvider());

    applyPi(models, config);

    const error = await authError(models, "faux");
    assert.equal(error.code, "config_invalid");
    assert.match(error.message, /faux/);
    assert.match(error.message, new RegExp(named));
  }
});

/**
 * The reason the case above needs an unconfigured builtin: a models.json apiKey
 * is read only when nothing else supplies one, so a stale `$VAR` beside a
 * working `pi login` must not take the review down with it.
 */
test("a stored credential leaves an unresolvable models.json apiKey unread", async () => {
  const models = createModels({ credentials: storedKey("from-auth-json") });
  models.setProvider(builtinProvider());

  applyPi(models, { apiKey: "$PI_KEY_NOTHING_SETS" });

  assert.equal((await models.getAuth("faux"))?.auth.apiKey, "from-auth-json");
});
