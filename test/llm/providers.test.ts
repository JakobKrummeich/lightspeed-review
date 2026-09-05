import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type {
  ApiKeyCredential,
  AuthResult,
  Credential,
  CredentialStore,
  Model,
  ModelAuth,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "../../src/config.ts";
import { applyConfiguredProviders } from "../../src/llm/providers.ts";
import { ReviewError } from "../../src/errors.ts";

interface SeenRequest {
  model?: Model<string>;
  apiKey?: string;
  headers?: Record<string, string>;
}

/** A faux provider that records the model and the auth each request went out with. */
function fauxModels(): { models: MutableModels; seen: SeenRequest } {
  const seen: SeenRequest = {};
  const faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    (_context, options, _state, model) => {
      seen.model = model;
      seen.apiKey = options?.apiKey;
      seen.headers = options?.headers as Record<string, string> | undefined;
      return fauxAssistantMessage("grouped");
    },
  ]);
  return { models, seen };
}

function run(models: MutableModels, provider = "faux", modelId = "faux-1"): Promise<unknown> {
  const model = models.getModel(provider, modelId);
  assert.ok(model, `expected ${provider}/${modelId} to resolve`);
  return models.completeSimple(model, { messages: [] });
}

function apply(models: MutableModels, providers: Record<string, ProviderConfig>): void {
  applyConfiguredProviders(models, providers);
}

function applyError(providers: Record<string, ProviderConfig>): ReviewError {
  try {
    apply(createModels(), providers);
  } catch (error) {
    assert.ok(error instanceof ReviewError, `expected ReviewError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected applyConfiguredProviders to throw");
}

/** A store holding one api-key credential, standing in for pi's auth.json. */
function storedKey(key: string): CredentialStore {
  const credential: ApiKeyCredential = { type: "api_key", key };
  return {
    read: async () => credential,
    list: async () => [{ providerId: "stored", type: "api_key" as const }],
    modify: async () => credential as Credential,
    delete: async () => undefined,
  };
}

/** A builtin stand-in that resolves headers of its own, the way a proxy auth does. */
function headerProvider(headers: Record<string, string>): Provider {
  const builtin = storedKeyProvider();
  return {
    ...builtin,
    auth: {
      apiKey: {
        name: "faux API key",
        resolve: async (): Promise<AuthResult> => ({ auth: { apiKey: "k", headers } }),
      },
    },
  };
}

/** A builtin stand-in whose credentials come from the store, the way pi's do. */
function storedKeyProvider(id = "faux"): Provider {
  return {
    id,
    name: id,
    baseUrl: "https://api.example.com",
    auth: {
      apiKey: {
        name: `${id} API key`,
        resolve: async ({ credential }): Promise<AuthResult | undefined> =>
          credential?.key ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
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

test("a configured baseUrl is the URL a request to a builtin provider goes to", async () => {
  const { models, seen } = fauxModels();

  apply(models, { faux: { baseUrl: "http://localhost:3001" } });
  await run(models);

  assert.equal(seen.model?.baseUrl, "http://localhost:3001");
});

test("configured headers ride along with the request", async () => {
  const { models, seen } = fauxModels();

  apply(models, { faux: { baseUrl: "http://localhost:3001", headers: { "x-corp-auth": "t" } } });
  await run(models);

  assert.equal(seen.headers?.["x-corp-auth"], "t");
});

test("overriding a builtin keeps the model catalogue it came with", async () => {
  const { models } = fauxModels();

  apply(models, { faux: { baseUrl: "http://localhost:3001" } });

  assert.deepEqual(
    models.getModels("faux").map((model) => model.id),
    ["faux-1", "faux-2"],
  );
});

test("a builtin override leaves every other provider alone", async () => {
  const { models } = fauxModels();
  const other = fauxProvider({ provider: "faux-other" });
  models.setProvider(other.provider);

  apply(models, { faux: { baseUrl: "http://localhost:3001" } });

  assert.equal(models.getProvider("faux-other"), other.provider);
});

test("a configured apiKey wins over the credential pi stored", async () => {
  const models = createModels({ credentials: storedKey("from-auth-json") });
  models.setProvider(storedKeyProvider());

  apply(models, { faux: { apiKey: "from-config" } });

  const auth = await models.getAuth("faux");
  assert.equal(auth?.auth.apiKey, "from-config");
});

test("without a configured apiKey the credential pi stored still authenticates", async () => {
  const models = createModels({ credentials: storedKey("from-auth-json") });
  models.setProvider(storedKeyProvider());

  apply(models, { faux: { baseUrl: "http://localhost:3001" } });

  const auth = await models.getAuth("faux");
  assert.equal(auth?.auth.apiKey, "from-auth-json");
  assert.equal(auth?.auth.baseUrl, "http://localhost:3001");
});

test("an OAuth credential carries the override too, key path or not", async () => {
  const credential = {
    type: "oauth" as const,
    refresh: "r",
    access: "a",
    expires: Date.now() + 1e6,
  };
  const models = createModels({
    credentials: {
      read: async () => credential,
      list: async () => [{ providerId: "faux", type: "oauth" as const }],
      modify: async () => credential,
      delete: async () => undefined,
    },
  });
  models.setProvider({
    ...storedKeyProvider(),
    auth: {
      oauth: {
        name: "faux oauth",
        login: async () => credential,
        refresh: async () => credential,
        toAuth: async (): Promise<ModelAuth> => ({ apiKey: "oauth-token" }),
      },
    },
  });

  apply(models, { faux: { baseUrl: "http://localhost:3001", headers: { "x-corp-auth": "t" } } });

  const auth = await models.getAuth("faux");
  assert.equal(auth?.auth.apiKey, "oauth-token");
  assert.equal(auth?.auth.baseUrl, "http://localhost:3001");
  assert.deepEqual(auth?.auth.headers, { "x-corp-auth": "t" });
});

test("a configured apiKey configures a builtin that had no credential at all", async () => {
  const models = createModels();
  models.setProvider(storedKeyProvider());

  apply(models, { faux: { baseUrl: "http://localhost:3001", apiKey: "from-config" } });

  const auth = await models.getAuth("faux");
  assert.equal(auth?.auth.apiKey, "from-config");
  assert.equal(auth?.auth.baseUrl, "http://localhost:3001");
});

test("a builtin with no credential and no configured key stays unconfigured", async () => {
  const models = createModels();
  models.setProvider(storedKeyProvider());

  apply(models, { faux: { baseUrl: "http://localhost:3001" } });

  assert.equal(await models.getAuth("faux"), undefined);
});

test("a configured header beats the one the builtin resolved", async () => {
  const models = createModels({ credentials: storedKey("k") });
  models.setProvider(headerProvider({ "x-corp-auth": "from-builtin", "x-keep": "builtin" }));

  apply(models, { faux: { headers: { "x-corp-auth": "from-config" } } });

  const auth = await models.getAuth("faux");
  assert.equal(auth?.auth.headers?.["x-corp-auth"], "from-config");
  assert.equal(auth?.auth.headers?.["x-keep"], "builtin");
});

/** pi-ai merges headers case-insensitively; a merge that does not ships both. */
test("a configured header replaces the builtin's however either spelled it", async () => {
  const models = createModels({ credentials: storedKey("k") });
  models.setProvider(headerProvider({ Authorization: "from-builtin" }));

  apply(models, { faux: { headers: { authorization: "from-config" } } });

  const headers = (await models.getAuth("faux"))?.auth.headers ?? {};
  assert.deepEqual(Object.values(headers), ["from-config"]);
});

test("a builtin id carrying what only a whole provider can carry is a config error", () => {
  for (const [key, config] of [
    ["model", { model: { id: "my-model" } }],
    ["api", { api: "openai-completions" as const }],
    ["name", { name: "my anthropic" }],
  ] satisfies [string, ProviderConfig][]) {
    const models = createModels();
    models.setProvider(storedKeyProvider());
    try {
      applyConfiguredProviders(models, { faux: config });
      throw new Error(`expected \`${key}\` on a builtin id to be rejected`);
    } catch (error) {
      assert.ok(error instanceof ReviewError, `expected ReviewError for ${key}`);
      assert.equal(error.code, "config_invalid");
      assert.match(error.message, /faux/);
      assert.match(error.message, new RegExp(key));
    }
  }
});

const gateway: ProviderConfig = {
  name: "Corp LLM gateway",
  baseUrl: "https://llm.corp.internal/openai",
  api: "azure-openai-responses",
  apiKey: "unused-by-the-gateway",
  headers: { "x-corp-auth": "real-secret" },
  model: { id: "gpt-5", reasoning: true },
};

test("a provider pi-ai never heard of resolves its one model", async () => {
  const models = createModels();

  apply(models, { "corp-gateway": gateway });

  const model = models.getModel("corp-gateway", "gpt-5");
  assert.equal(model?.baseUrl, "https://llm.corp.internal/openai");
  assert.equal(model?.api, "azure-openai-responses");
  assert.equal(model?.provider, "corp-gateway");
  assert.equal(model?.reasoning, true);
});

test("a custom provider's request carries the dummy key and the custom header", async () => {
  const models = createModels();

  apply(models, { "corp-gateway": gateway });

  const model = models.getModel("corp-gateway", "gpt-5");
  assert.ok(model);
  const auth = await models.getAuth(model);
  assert.equal(auth?.auth.apiKey, "unused-by-the-gateway");
  assert.deepEqual(auth?.auth.headers, { "x-corp-auth": "real-secret" });
});

/**
 * A header-auth gateway needs no credential file, so nothing pi ever logged into may decide what
 * a configured provider sends — a store entry sharing the id would otherwise silently take over.
 */
test("a credential in pi's file does not decide a configured provider", async () => {
  const models = createModels({ credentials: storedKey("from-auth-json") });

  apply(models, { "corp-gateway": gateway });

  const model = models.getModel("corp-gateway", "gpt-5");
  assert.ok(model);
  assert.equal((await models.getAuth(model))?.auth.apiKey, "unused-by-the-gateway");
});

test("a keyless custom provider is still configured, so the gateway gets to reject it", async () => {
  const models = createModels();

  apply(models, {
    "corp-gateway": { ...gateway, apiKey: undefined, headers: { "x-corp-auth": "t" } },
  });

  const model = models.getModel("corp-gateway", "gpt-5");
  assert.ok(model);
  const auth = await models.getAuth(model);
  assert.equal(auth?.auth.apiKey, undefined);
  assert.deepEqual(auth?.auth.headers, { "x-corp-auth": "t" });
});

test("a custom model takes the documented defaults for everything it leaves out", async () => {
  const models = createModels();

  apply(models, {
    "corp-gateway": { baseUrl: "https://x", api: "openai-completions", model: { id: "gpt-5" } },
  });

  const model = models.getModel("corp-gateway", "gpt-5");
  assert.equal(model?.name, "gpt-5");
  assert.equal(model?.reasoning, false);
  assert.deepEqual(model?.input, ["text"]);
  assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(model?.contextWindow, 200000);
  assert.equal(model?.maxTokens, 16384);
});

test("a custom model may sit on a URL of its own", async () => {
  const models = createModels();

  apply(models, {
    "corp-gateway": {
      baseUrl: "https://x",
      api: "openai-completions",
      model: { id: "gpt-5", baseUrl: "https://y" },
    },
  });

  assert.equal(models.getModel("corp-gateway", "gpt-5")?.baseUrl, "https://y");
});

test("thinkingLevelMap and compat reach pi-ai untouched", async () => {
  const models = createModels();

  apply(models, {
    "corp-gateway": {
      baseUrl: "https://x",
      api: "openai-completions",
      model: {
        id: "gpt-5",
        thinkingLevelMap: { medium: "balanced" },
        compat: { reasoningEffort: false },
      },
    },
  });

  const model = models.getModel("corp-gateway", "gpt-5");
  assert.deepEqual(model?.thinkingLevelMap, { medium: "balanced" });
  assert.deepEqual(model?.compat, { reasoningEffort: false });
});

test("a provider pi-ai never heard of needs an api", () => {
  const error = applyError({ "corp-gateway": { baseUrl: "https://x", model: { id: "gpt-5" } } });

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /corp-gateway/);
  assert.match(error.message, /api/);
});

test("a provider pi-ai never heard of needs a model", () => {
  const error = applyError({ "corp-gateway": { baseUrl: "https://x", api: "openai-completions" } });

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /corp-gateway/);
  assert.match(error.message, /model/);
});

test("a provider pi-ai never heard of needs a URL to talk to", () => {
  const error = applyError({
    "corp-gateway": { api: "openai-completions", model: { id: "gpt-5" } },
  });

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /corp-gateway/);
  assert.match(error.message, /baseUrl/);
});

/** The no-regression case: an absent `providers` must leave the builtins as they are. */
test("no configured providers leaves the collection exactly as it was", () => {
  const { models } = fauxModels();
  const before = models.getProviders();

  applyConfiguredProviders(models, undefined);

  assert.deepEqual(models.getProviders(), before);
  assert.equal(models.getProvider("faux"), before[0]);
});
