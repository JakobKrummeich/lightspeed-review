import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadLedgerConfig } from "../src/config.ts";
import { ReviewError } from "../src/errors.ts";

function repoWithConfig(contents: string | undefined): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "lsr-config-"));
  if (contents !== undefined) {
    writeFileSync(join(repoRoot, ".lightspeed.conf.json"), contents);
  }
  return repoRoot;
}

function loadError(contents: string | undefined): ReviewError {
  try {
    loadConfig(repoWithConfig(contents));
  } catch (error) {
    assert.ok(error instanceof ReviewError, `expected ReviewError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected loadConfig to throw");
}

test("reads model and thinking from .lightspeed.conf.json", () => {
  const repoRoot = repoWithConfig(
    JSON.stringify({ model: "anthropic/claude-sonnet-4-5", thinking: "off" }),
  );

  const config = loadConfig(repoRoot);

  assert.equal(config.model, "anthropic/claude-sonnet-4-5");
  assert.equal(config.thinking, "off");
});

test("applies documented defaults for the optional keys", () => {
  const repoRoot = repoWithConfig(JSON.stringify({ model: "openai/gpt-5", thinking: "medium" }));

  const config = loadConfig(repoRoot);

  assert.equal(config.port, 4388);
  assert.equal(config.stateDir, join(homedir(), ".lightspeed"));
  assert.equal(config.feedbackLog, "on");
});

test("expands a leading ~ in stateDir", () => {
  const repoRoot = repoWithConfig(
    JSON.stringify({ model: "openai/gpt-5", thinking: "off", stateDir: "~/custom-state" }),
  );

  assert.equal(loadConfig(repoRoot).stateDir, join(homedir(), "custom-state"));
});

test("keeps an explicit port", () => {
  const repoRoot = repoWithConfig(
    JSON.stringify({ model: "openai/gpt-5", thinking: "off", port: 5000 }),
  );

  assert.equal(loadConfig(repoRoot).port, 5000);
});

test("a retired groupingThreshold still loads, and decides nothing", () => {
  const repoRoot = repoWithConfig(
    JSON.stringify({ model: "openai/gpt-5", thinking: "off", groupingThreshold: 2 }),
  );

  const config = loadConfig(repoRoot);

  assert.equal(config.model, "openai/gpt-5");
  assert.ok(!("groupingThreshold" in config));
});

test("missing config file fails fast with config_missing", () => {
  const error = loadError(undefined);

  assert.equal(error.code, "config_missing");
  assert.match(error.message, /\.lightspeed\.conf\.json/);
  assert.ok(error.suggestions.length > 0);
});

test("unparseable JSON reports config_invalid", () => {
  assert.equal(loadError("{ not json").code, "config_invalid");
});

test("missing model reports config_invalid naming the key", () => {
  const error = loadError(JSON.stringify({ thinking: "off" }));

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /model/);
});

test("missing thinking reports config_invalid naming the key", () => {
  const error = loadError(JSON.stringify({ model: "openai/gpt-5" }));

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /thinking/);
});

test("thinking must be one of Pi's ModelThinkingLevel values", () => {
  const error = loadError(JSON.stringify({ model: "openai/gpt-5", thinking: "none" }));

  assert.equal(error.code, "config_invalid");
  assert.equal(error.detail, "valid values: off, minimal, low, medium, high, xhigh, max");
});

test("thinking accepts every ModelThinkingLevel value", () => {
  for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const repoRoot = repoWithConfig(JSON.stringify({ model: "openai/gpt-5", thinking }));
    assert.equal(loadConfig(repoRoot).thinking, thinking);
  }
});

test("boolean thinking is rejected — it is a level, not a switch", () => {
  assert.equal(
    loadError(JSON.stringify({ model: "openai/gpt-5", thinking: false })).code,
    "config_invalid",
  );
});

test("port outside the valid range reports config_invalid", () => {
  const error = loadError(JSON.stringify({ model: "openai/gpt-5", thinking: "off", port: 70000 }));

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /port/);
});

test("unknown keys are rejected so typos never silently do nothing", () => {
  const error = loadError(
    JSON.stringify({ model: "openai/gpt-5", thinking: "off", groupingTreshold: 3 }),
  );

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /groupingTreshold/);
});

test("feedbackLog defaults to on", () => {
  const repoRoot = repoWithConfig(JSON.stringify({ model: "openai/gpt-5", thinking: "off" }));

  assert.equal(loadConfig(repoRoot).feedbackLog, "on");
});

test("feedbackLog can be switched off", () => {
  const repoRoot = repoWithConfig(
    JSON.stringify({ model: "openai/gpt-5", thinking: "off", feedbackLog: "off" }),
  );

  assert.equal(loadConfig(repoRoot).feedbackLog, "off");
});

test("a feedbackLog value that is neither on nor off reports config_invalid", () => {
  const error = loadError(
    JSON.stringify({ model: "openai/gpt-5", thinking: "off", feedbackLog: "yes" }),
  );

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /feedbackLog/);
  assert.equal(error.detail, "valid values: on, off");
});

test("a boolean feedbackLog is rejected — it is a string switch", () => {
  assert.equal(
    loadError(JSON.stringify({ model: "openai/gpt-5", thinking: "off", feedbackLog: true })).code,
    "config_invalid",
  );
});

function configWithClassify(classify: unknown): string {
  return JSON.stringify({ model: "openai/gpt-5", thinking: "off", classify });
}

test("classify defaults to two empty lists, so the classifier's own rules stand alone", () => {
  const repoRoot = repoWithConfig(JSON.stringify({ model: "openai/gpt-5", thinking: "off" }));

  assert.deepEqual(loadConfig(repoRoot).classify, { mechanical: [], guardrail: [] });
});

test("classify globs are read as written, in the order the file lists them", () => {
  const repoRoot = repoWithConfig(
    configWithClassify({ mechanical: ["docs/api/**", "*.snap"], guardrail: ["app/payments/**"] }),
  );

  assert.deepEqual(loadConfig(repoRoot).classify, {
    mechanical: ["docs/api/**", "*.snap"],
    guardrail: ["app/payments/**"],
  });
});

test("one classify list may be given without the other", () => {
  const repoRoot = repoWithConfig(configWithClassify({ guardrail: ["app/payments/**"] }));

  assert.deepEqual(loadConfig(repoRoot).classify, {
    mechanical: [],
    guardrail: ["app/payments/**"],
  });
});

test("a classify list that is no list of globs reports config_invalid naming the key", () => {
  const error = loadError(configWithClassify({ mechanical: "docs/api/**" }));

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /classify\.mechanical/);
});

test("an empty glob is rejected: it would match nothing and say it was configured", () => {
  const error = loadError(configWithClassify({ guardrail: [""] }));

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /classify\.guardrail/);
});

test("classify must be an object of the two known lists, of strings", () => {
  for (const classify of [
    [],
    "docs/api/**",
    { mechanic: ["docs/api/**"] },
    { mechanical: [7] },
    { guardrail: { "app/payments/**": true } },
  ]) {
    assert.equal(
      loadError(configWithClassify(classify)).code,
      "config_invalid",
      `expected ${JSON.stringify(classify)} to be rejected`,
    );
  }
});

function withEnv(vars: Record<string, string>, body: () => void): void {
  const before = new Map(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function configWithProviders(providers: unknown): string {
  return JSON.stringify({ model: "openai/gpt-5", thinking: "off", providers });
}

test("a config without providers carries none, which is the untouched behaviour", () => {
  const config = loadConfig(
    repoWithConfig(JSON.stringify({ model: "openai/gpt-5", thinking: "off" })),
  );

  assert.equal(config.providers, undefined);
});

test("a builtin provider can be overridden with nothing but a baseUrl", () => {
  const repoRoot = repoWithConfig(
    configWithProviders({ anthropic: { baseUrl: "http://localhost:3001" } }),
  );

  assert.deepEqual(loadConfig(repoRoot).providers, {
    anthropic: { baseUrl: "http://localhost:3001" },
  });
});

test("a provider pi-ai has never heard of is read whole, model and all", () => {
  const repoRoot = repoWithConfig(
    configWithProviders({
      "corp-gateway": {
        name: "Corp LLM gateway",
        baseUrl: "https://llm.corp.internal/openai",
        api: "azure-openai-responses",
        apiKey: "unused-by-the-gateway",
        headers: { "x-corp-auth": "secret" },
        model: { id: "gpt-5", reasoning: true, contextWindow: 200000, maxTokens: 16384 },
      },
    }),
  );

  assert.deepEqual(loadConfig(repoRoot).providers?.["corp-gateway"], {
    name: "Corp LLM gateway",
    baseUrl: "https://llm.corp.internal/openai",
    api: "azure-openai-responses",
    apiKey: "unused-by-the-gateway",
    headers: { "x-corp-auth": "secret" },
    model: { id: "gpt-5", reasoning: true, contextWindow: 200000, maxTokens: 16384 },
  });
});

test("${VAR} in an apiKey and in a header value is read from the environment", () => {
  withEnv({ CORP_LLM_TOKEN: "t-secret", CORP_KEY: "k-secret" }, () => {
    const repoRoot = repoWithConfig(
      configWithProviders({
        "corp-gateway": {
          api: "openai-completions",
          apiKey: "${CORP_KEY}",
          headers: { "x-corp-auth": "Bearer ${CORP_LLM_TOKEN}" },
          model: { id: "gpt-5" },
        },
      }),
    );

    const provider = loadConfig(repoRoot).providers?.["corp-gateway"];

    assert.equal(provider?.apiKey, "k-secret");
    assert.deepEqual(provider?.headers, { "x-corp-auth": "Bearer t-secret" });
  });
});

test("a $ that is not ${...} is a literal, in an apiKey and in a header alike", () => {
  const repoRoot = repoWithConfig(
    configWithProviders({
      "corp-gateway": {
        api: "openai-completions",
        apiKey: "pa$$word$",
        headers: { "x-corp-auth": "$HOME is not expanded" },
        model: { id: "gpt-5" },
      },
    }),
  );

  const provider = loadConfig(repoRoot).providers?.["corp-gateway"];

  assert.equal(provider?.apiKey, "pa$$word$");
  assert.deepEqual(provider?.headers, { "x-corp-auth": "$HOME is not expanded" });
});

test("an unset variable names both the variable and the provider that wanted it", () => {
  const error = loadError(
    configWithProviders({
      "corp-gateway": {
        apiKey: "${LIGHTSPEED_NEVER_SET_TOKEN}",
        api: "openai-completions",
        model: { id: "m" },
      },
    }),
  );

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /LIGHTSPEED_NEVER_SET_TOKEN/);
  assert.match(error.message, /corp-gateway/);
});

test("an unset variable in a header value fails the same way", () => {
  const error = loadError(
    configWithProviders({ anthropic: { headers: { "x-a": "${LIGHTSPEED_NEVER_SET_HEADER}" } } }),
  );

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /LIGHTSPEED_NEVER_SET_HEADER/);
  assert.match(error.message, /anthropic/);
});

test("a variable is expanded nowhere but the apiKey and the header values", () => {
  withEnv({ CORP_HOST: "llm.corp.internal" }, () => {
    const repoRoot = repoWithConfig(
      configWithProviders({
        "corp-gateway": {
          baseUrl: "https://${CORP_HOST}/openai",
          api: "openai-completions",
          model: { id: "gpt-5" },
        },
      }),
    );

    assert.equal(
      loadConfig(repoRoot).providers?.["corp-gateway"]?.baseUrl,
      "https://${CORP_HOST}/openai",
    );
  });
});

/**
 * pi-ai reads `ModelAuth.baseUrl` for truthiness: an empty one silently sends the request to the
 * vendor the entry exists to avoid.
 */
test("an empty baseUrl is a typo, not an override", () => {
  for (const providers of [
    { anthropic: { baseUrl: "" } },
    { anthropic: { model: { id: "m", baseUrl: "" } } },
  ]) {
    const error = loadError(configWithProviders(providers));
    assert.equal(error.code, "config_invalid");
    assert.match(error.message, /baseUrl/);
  }
});

test("an empty apiKey is rejected, written out or expanded to one", () => {
  withEnv({ CORP_EMPTY: "" }, () => {
    for (const apiKey of ["", "${CORP_EMPTY}"]) {
      const error = loadError(configWithProviders({ anthropic: { apiKey } }));
      assert.equal(error.code, "config_invalid");
      assert.match(error.message, /apiKey/);
    }
  });
});

/**
 * Undici rejects a newline in a header by quoting the value back — onto stdout and into CI logs.
 * The secret must fail at load, and the failure must not repeat it.
 */
test("a header value carrying a newline fails at load and is never quoted back", () => {
  withEnv({ CORP_LLM_TOKEN: "super-secret\n" }, () => {
    const error = loadError(
      configWithProviders({ anthropic: { headers: { "x-corp-auth": "${CORP_LLM_TOKEN}" } } }),
    );

    assert.equal(error.code, "config_invalid");
    assert.match(error.message, /x-corp-auth/);
    assert.doesNotMatch(`${error.message} ${error.detail ?? ""}`, /super-secret/);
  });
});

test("a carriage return or a NUL in a header value fails the same way", () => {
  for (const value of ["a\rb", "a\u0000b", "a\r\nb"]) {
    assert.equal(
      loadError(configWithProviders({ anthropic: { headers: { "x-a": value } } })).code,
      "config_invalid",
    );
  }
});

test("a header name that is no HTTP token is rejected", () => {
  for (const header of ["x corp", "x:corp", "x\ncorp", ""]) {
    assert.equal(
      loadError(configWithProviders({ anthropic: { headers: { [header]: "v" } } })).code,
      "config_invalid",
    );
  }
});

test("a provider id that is no provider id is rejected, `__proto__` included", () => {
  for (const id of ["  ", "__proto__", "corp gateway", "corp/gateway"]) {
    const error = loadError(configWithProviders({ [id]: { baseUrl: "http://x" } }));
    assert.equal(error.code, "config_invalid", `expected ${id} to be rejected`);
  }
});

test("a provider entry never reaches the prototype of the map it lands in", () => {
  const repoRoot = repoWithConfig(configWithProviders({ anthropic: { baseUrl: "http://x" } }));

  assert.equal(Object.keys(loadConfig(repoRoot).providers ?? {}).length, 1);
  assert.equal(({} as Record<string, unknown>).baseUrl, undefined);
});

test("a `${}` with no variable name says so rather than naming nothing", () => {
  const error = loadError(configWithProviders({ anthropic: { apiKey: "${}" } }));

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /variable name/);
});

test("an api outside the allowlist fails at load, not mid-request", () => {
  const error = loadError(
    configWithProviders({ "corp-gateway": { api: "azure-openai-response", model: { id: "m" } } }),
  );

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /api/);
  assert.match(error.detail ?? "", /azure-openai-responses/);
});

test("every allowlisted api is accepted", () => {
  for (const api of [
    "anthropic-messages",
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "google-generative-ai",
  ]) {
    const repoRoot = repoWithConfig(
      configWithProviders({ "corp-gateway": { api, model: { id: "m" } } }),
    );
    assert.equal(loadConfig(repoRoot).providers?.["corp-gateway"]?.api, api);
  }
});

test("an unknown key inside a provider entry reports config_invalid naming it", () => {
  const error = loadError(configWithProviders({ anthropic: { base_url: "http://x" } }));

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /base_url/);
});

test("an unknown key inside a model entry reports config_invalid naming it", () => {
  const error = loadError(
    configWithProviders({ anthropic: { model: { id: "m", context_window: 10 } } }),
  );

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /context_window/);
});

test("a model entry without an id reports config_invalid", () => {
  const error = loadError(configWithProviders({ anthropic: { model: { name: "nameless" } } }));

  assert.equal(error.code, "config_invalid");
  assert.match(error.message, /id/);
});

test("an empty provider id reports config_invalid", () => {
  assert.equal(
    loadError(configWithProviders({ "": { baseUrl: "http://x" } })).code,
    "config_invalid",
  );
});

test("providers must be an object of objects, and every field must have its type", () => {
  for (const providers of [
    [],
    "anthropic",
    { anthropic: "http://x" },
    { anthropic: { baseUrl: 7 } },
    { anthropic: { headers: { "x-a": 7 } } },
    { anthropic: { headers: ["x-a"] } },
    { anthropic: { model: "gpt-5" } },
    { anthropic: { model: { id: 7 } } },
    { anthropic: { model: { id: "m", reasoning: "yes" } } },
    { anthropic: { model: { id: "m", input: "text" } } },
    { anthropic: { model: { id: "m", contextWindow: -1 } } },
    { anthropic: { model: { id: "m", cost: 0 } } },
  ]) {
    assert.equal(
      loadError(configWithProviders(providers)).code,
      "config_invalid",
      `expected ${JSON.stringify(providers)} to be rejected`,
    );
  }
});

/**
 * The ledger spans every repository, so its reader must run where no repo or config exists —
 * but a config that is there still decides which ledger it reads.
 */
test("the ledger config reads from a plain directory that is no repository", () => {
  const config = loadLedgerConfig(mkdtempSync(join(tmpdir(), "lsr-config-none-")));

  assert.equal(config.stateDir, join(homedir(), ".lightspeed"));
  assert.equal(config.feedbackLog, "on");
});

test("the ledger config needs neither model nor thinking", () => {
  const repoRoot = repoWithConfig(JSON.stringify({ stateDir: "/tmp/ledger", feedbackLog: "off" }));

  const config = loadLedgerConfig(repoRoot);

  assert.equal(config.stateDir, "/tmp/ledger");
  assert.equal(config.feedbackLog, "off");
});

test("a repository with no config file at all reads the default ledger", () => {
  const config = loadLedgerConfig(repoWithConfig(undefined));

  assert.equal(config.stateDir, join(homedir(), ".lightspeed"));
});

test("the ledger config still rejects a config file it cannot trust", () => {
  for (const contents of ['{"stateDir": 7}', '{"feedbackLog": "yes"}', '{"statedir": "/tmp"}']) {
    assert.throws(() => loadLedgerConfig(repoWithConfig(contents)), {
      code: "config_invalid",
    });
  }
});
