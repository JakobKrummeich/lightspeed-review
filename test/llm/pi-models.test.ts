import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import type { ApiKeyCredential, Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
  loadPiProviders,
  resolvePiConfigValue,
  resolvePiStaticConfigValue,
} from "../../src/llm/pi-models.ts";
import { applyConfiguredProviders, applyPiProviders } from "../../src/llm/providers.ts";

function piModelsFile(contents: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), "lightspeed-pi-models-"));
  const path = join(directory, "models.json");
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const piConfig = {
  providers: {
    "pi-gateway": {
      name: "Pi gateway",
      baseUrl: "https://gateway.example.test/v1",
      api: "openai-completions",
      apiKey: "test-api-key",
      headers: { "x-pi-route": "review" },
      modelOverrides: {
        "pi-large": { cost: { output: 3 }, thinkingLevelMap: { medium: "balanced" } },
      },
      models: [
        {
          id: "pi-large",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 123456,
          maxTokens: 8192,
          compat: { supportsDeveloperRole: false },
        },
        {
          id: "pi-small",
          headers: { "x-pi-model": "$PI_MODEL_HEADER" },
        },
      ],
    },
  },
};

test("loads Pi models.json provider definitions without moving them into repo config", async () => {
  await withEnv({ PI_MODEL_HEADER: "model-header" }, async () => {
    const providers = loadPiProviders(piModelsFile(piConfig));
    const models = createModels();

    applyPiProviders(models, providers);

    const large = models.getModel("pi-gateway", "pi-large");
    const small = models.getModel("pi-gateway", "pi-small");
    assert.equal(large?.baseUrl, "https://gateway.example.test/v1");
    assert.equal(large?.reasoning, true);
    assert.deepEqual(large?.input, ["text", "image"]);
    assert.deepEqual(large?.compat, { supportsDeveloperRole: false });
    assert.deepEqual(large?.cost, { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(large?.thinkingLevelMap, { medium: "balanced" });
    assert.equal(small?.maxTokens, 16384);
    assert.deepEqual((await models.getAuth(large!))?.auth.headers, { "x-pi-route": "review" });
    assert.deepEqual((await models.getAuth(small!))?.auth.headers, {
      "x-pi-route": "review",
      "x-pi-model": "model-header",
    });
    assert.equal((await models.getAuth(large!))?.auth.apiKey, "test-api-key");
  });
});

function storedKey(key: string, env?: Record<string, string>): CredentialStore {
  const credential: ApiKeyCredential = { type: "api_key", key, ...(env ? { env } : {}) };
  return {
    read: async () => credential,
    list: async () => [{ providerId: "pi-gateway", type: "api_key" as const }],
    modify: async () => credential as Credential,
    delete: async () => undefined,
  };
}

function withEnv(values: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const before = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);
  return body().finally(() => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("Pi command expressions execute for each auth resolution", async () => {
  await withEnv({ PI_COMMAND_KEY: "first" }, async () => {
    const command = `!${process.execPath} -e "process.stdout.write(process.env.PI_COMMAND_KEY)"`;
    assert.equal(await resolvePiConfigValue(command, async () => undefined), "first");
    process.env.PI_COMMAND_KEY = "second";
    assert.equal(await resolvePiConfigValue(command, async () => undefined), "second");
  });
});

/**
 * Pi's value syntax is read by two resolvers: the async one for provider
 * credentials (a stored credential's env answers before this process's does)
 * and the sync one for model headers. Where a name is looked up is theirs to
 * differ on; what the syntax means is not, so the table is asserted against
 * both. A case only one of them satisfies is a config that works for a provider
 * header and fails for a model header, reported as the wrong field's fault.
 */
const PI_VALUE_CASES: { value: string; resolved: string | undefined; reading: string }[] = [
  { value: "test-api-key", resolved: "test-api-key", reading: "a value with no token is itself" },
  { value: "$PI_TEST_KEY", resolved: "secret", reading: "$NAME is the variable's value" },
  { value: "${PI_TEST_KEY}", resolved: "secret", reading: "${NAME} bounds the name" },
  {
    value: "sk-${PI_TEST_KEY}-$PI_TEST_ROUTE/v1",
    resolved: "sk-secret-eu/v1",
    reading: "text before, between and after the tokens is kept",
  },
  {
    value: "$PI_TEST_KEY$PI_TEST_ROUTE",
    resolved: "secreteu",
    reading: "adjacent tokens leave nothing between them",
  },
  { value: "a$$b", resolved: "a$b", reading: "$$ is a literal dollar, not a lookup" },
  {
    value: "$!/usr/bin/false",
    resolved: "!/usr/bin/false",
    reading: "$! is a literal bang: the value is text, not a command",
  },
  {
    value: "$PI_TEST_MISSING",
    resolved: undefined,
    reading: "an unset variable resolves to nothing at all, never to an empty value",
  },
  {
    value: "sk-$PI_TEST_MISSING-$PI_TEST_KEY",
    resolved: undefined,
    reading: "one unset variable voids the whole value, not just its own token",
  },
];

test("both Pi value resolvers read the same syntax", async () => {
  const lookup = async (name: string): Promise<string | undefined> => process.env[name];
  await withEnv({ PI_TEST_KEY: "secret", PI_TEST_ROUTE: "eu" }, async () => {
    for (const { value, resolved, reading } of PI_VALUE_CASES) {
      assert.equal(await resolvePiConfigValue(value, lookup), resolved, `credentials: ${reading}`);
      assert.equal(resolvePiStaticConfigValue(value), resolved, `model headers: ${reading}`);
    }
  });
});

test("a model header's `!command` is run by the static resolver too", async () => {
  await withEnv({ PI_COMMAND_KEY: "from-command" }, async () => {
    const command = `!${process.execPath} -e "process.stdout.write(process.env.PI_COMMAND_KEY)"`;

    assert.equal(resolvePiStaticConfigValue(command), "from-command");
  });
});

test("Pi apiKey and headers resolve environment expressions when no credential is stored", async () => {
  await withEnv(
    { OPENAI_API_KEY: "test-openai-key", CORP_GATEWAY_API_KEY: "test-gateway-key" },
    async () => {
      const models = createModels();
      applyPiProviders(models, {
        "pi-gateway": {
          baseUrl: "https://gateway.example.test/v1",
          api: "azure-openai-responses",
          apiKey: "$OPENAI_API_KEY",
          authHeader: true,
          headers: { "x-corp-gateway-key": "$CORP_GATEWAY_API_KEY" },
          models: [{ id: "azure-model", headers: { "x-model-header": "model" } }],
        },
      });

      const model = models.getModel("pi-gateway", "azure-model");
      assert.ok(model);
      const auth = await models.getAuth(model);
      assert.equal(auth?.auth.apiKey, "test-openai-key");
      assert.deepEqual(auth?.auth.headers, {
        "x-corp-gateway-key": "test-gateway-key",
        Authorization: "Bearer test-openai-key",
        "x-model-header": "model",
      });
    },
  );
});

test("stored Pi credentials win over Pi models.json apiKey while Pi headers remain merged", async () => {
  await withEnv({ CORP_GATEWAY_API_KEY: "test-gateway-key" }, async () => {
    const models = createModels({
      credentials: storedKey("stored-key", { CORP_GATEWAY_API_KEY: "stored-gateway-key" }),
    });
    applyPiProviders(models, {
      "pi-gateway": {
        baseUrl: "https://gateway.example.test/v1",
        api: "azure-openai-responses",
        apiKey: "$OPENAI_API_KEY",
        headers: { "x-corp-gateway-key": "$CORP_GATEWAY_API_KEY" },
        models: [{ id: "azure-model" }],
      },
    });

    const model = models.getModel("pi-gateway", "azure-model");
    assert.ok(model);
    const auth = await models.getAuth(model);
    assert.equal(auth?.auth.apiKey, "stored-key");
    assert.deepEqual(auth?.auth.headers, { "x-corp-gateway-key": "stored-gateway-key" });
  });
});

test("repo provider overrides take precedence over Pi models.json providers", async () => {
  await withEnv({ PI_MODEL_HEADER: "model-header" }, async () => {
    const models = createModels();
    applyPiProviders(models, loadPiProviders(piModelsFile(piConfig)));

    applyConfiguredProviders(models, {
      "pi-gateway": { baseUrl: "http://repo-proxy.example.test/v1" },
    });

    const model = models.getModel("pi-gateway", "pi-large");
    assert.ok(model);
    assert.equal((await models.getAuth(model))?.auth.baseUrl, "http://repo-proxy.example.test/v1");
  });
});
