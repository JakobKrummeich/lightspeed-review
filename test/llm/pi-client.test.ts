import { test } from "node:test";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Context, Message, Model, MutableModels } from "@earendil-works/pi-ai";
import { runGroupingCall } from "../../src/llm/pi-client.ts";
import { ReviewError } from "../../src/errors.ts";
import type { ProviderConfig, ThinkingLevel } from "../../src/config.ts";

function fauxModels(
  responses: ReturnType<typeof fauxAssistantMessage>[],
  provider?: { id: string; model: string },
): {
  models: MutableModels;
  seen: { context: unknown; model?: Model<string> };
} {
  const seen: { context: unknown; model?: Model<string> } = { context: undefined };
  const faux = provider
    ? fauxProvider({ provider: provider.id, models: [{ id: provider.model }] })
    : fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    responses.map(
      (response) =>
        (context: Context, _options: unknown, _state: unknown, model: Model<string>) => {
          seen.context = context;
          seen.model = model;
          return response;
        },
    ),
  );
  return { models, seen };
}

function call(
  models: MutableModels,
  messages: Message[],
  thinking: ThinkingLevel = "off",
  model = "faux/faux-1",
) {
  return runGroupingCall({
    model,
    thinking,
    stateDir: "/tmp/lsr",
    systemPrompt: "group these files",
    messages,
    models,
  });
}

const userMessage: Message = { role: "user", content: "here is the diff", timestamp: 0 };

async function callProvider(
  models: MutableModels,
  providers: Record<string, ProviderConfig>,
): Promise<ReviewError> {
  try {
    await runGroupingCall({
      model: "faux/faux-1",
      thinking: "off",
      stateDir: "/tmp/lsr",
      providers,
      systemPrompt: "group these files",
      messages: [userMessage],
      models,
    });
  } catch (error) {
    assert.ok(error instanceof ReviewError, `expected ReviewError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected runGroupingCall to throw");
}

test("returns the assistant text for a successful call", async () => {
  const { models } = fauxModels([fauxAssistantMessage('{"groups": []}')]);

  const result = await call(models, [userMessage]);

  assert.equal(result.text, '{"groups": []}');
});

test("returns the conversation extended by the assistant reply so it can be continued", async () => {
  const { models } = fauxModels([fauxAssistantMessage("first answer")]);

  const result = await call(models, [userMessage]);

  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0], userMessage);
  assert.equal(result.messages[1]?.role, "assistant");
});

test("passes the system prompt and messages to the model", async () => {
  const { models, seen } = fauxModels([fauxAssistantMessage("ok")]);

  await call(models, [userMessage]);

  const context = seen.context as { systemPrompt: string; messages: Message[] };
  assert.equal(context.systemPrompt, "group these files");
  assert.deepEqual(context.messages, [userMessage]);
});

test("an unknown provider reports pi_model_unknown", async () => {
  const { models } = fauxModels([fauxAssistantMessage("ok")]);

  await assert.rejects(
    () => call(models, [userMessage], "off", "nosuchprovider/model-x"),
    (error: unknown) => error instanceof ReviewError && error.code === "pi_model_unknown",
  );
});

test("an unknown model id on a known provider reports pi_model_unknown", async () => {
  const { models } = fauxModels([fauxAssistantMessage("ok")]);

  await assert.rejects(
    () => call(models, [userMessage], "off", "faux/not-a-model"),
    (error: unknown) => error instanceof ReviewError && error.code === "pi_model_unknown",
  );
});

test("a model without a provider prefix reports pi_model_unknown", async () => {
  const { models } = fauxModels([fauxAssistantMessage("ok")]);

  await assert.rejects(
    () => call(models, [userMessage], "off", "faux-1"),
    (error: unknown) => error instanceof ReviewError && error.code === "pi_model_unknown",
  );
});

test("a credential the provider rejects reports pi_auth_failed", async () => {
  const { models } = fauxModels([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
  ]);

  await assert.rejects(
    () => call(models, [userMessage]),
    (error: unknown) => error instanceof ReviewError && error.code === "pi_auth_failed",
  );
});

test("any other stream error reports pi_stream_failed carrying the provider message", async () => {
  const { models } = fauxModels([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 503" }),
  ]);

  await assert.rejects(
    () => call(models, [userMessage]),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "pi_stream_failed" &&
      error.detail === "upstream 503",
  );
});

test("an aborted request reports pi_stream_failed", async () => {
  const { models } = fauxModels([
    fauxAssistantMessage("partial", { stopReason: "aborted", errorMessage: "cancelled" }),
  ]);

  await assert.rejects(
    () => call(models, [userMessage]),
    (error: unknown) => error instanceof ReviewError && error.code === "pi_stream_failed",
  );
});

test("a configured provider decides where the grouping request is sent", async () => {
  const { models, seen } = fauxModels([fauxAssistantMessage("ok")]);

  await runGroupingCall({
    model: "faux/faux-1",
    thinking: "off",
    stateDir: "/tmp/lsr",
    providers: { faux: { baseUrl: "http://localhost:3001" } },
    systemPrompt: "group these files",
    messages: [userMessage],
    models,
  });

  assert.equal(seen.model?.baseUrl, "http://localhost:3001");
});

/**
 * A down proxy fails like any network failure, so the message must name the
 * URL tried — the config points at one nothing else mentions.
 */
test("a failure against a configured provider names the URL the config chose", async () => {
  const { models } = fauxModels([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
  ]);

  const error = await callProvider(models, {
    faux: {
      baseUrl: "http://localhost:3001",
      apiKey: "the-secret-key",
      headers: { "x-corp-auth": "the-secret-header" },
    },
  });

  assert.equal(error.code, "pi_stream_failed");
  assert.ok(
    error.suggestions.some(
      (suggestion) =>
        suggestion.includes("http://localhost:3001") &&
        suggestion.includes("providers.faux.baseUrl"),
    ),
    `no suggestion named the endpoint: ${error.suggestions.join(" | ")}`,
  );
});

test("nothing a failure reports carries the credential it was configured with", async () => {
  const { models } = fauxModels([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
  ]);

  const error = await callProvider(models, {
    faux: {
      baseUrl: "http://localhost:3001",
      apiKey: "the-secret-key",
      headers: { "x-corp-auth": "the-secret-header" },
    },
  });

  const reported = [error.message, error.detail ?? "", ...error.suggestions].join(" ");
  assert.equal(error.code, "pi_auth_failed");
  assert.doesNotMatch(reported, /the-secret-key|the-secret-header/);
});

test("a missing credential for a login-capable provider suggests lightspeed login first", async () => {
  const { models } = fauxModels(
    [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Provider is not configured: anthropic",
      }),
    ],
    { id: "anthropic", model: "claude-sonnet-4-5" },
  );

  await assert.rejects(
    () => call(models, [userMessage], "off", "anthropic/claude-sonnet-4-5"),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "pi_auth_missing" &&
      error.suggestions[0]?.includes("lightspeed login anthropic") === true &&
      error.suggestions.some((line) => line.includes("export")),
  );
});

test("a rejected credential for a login-capable provider suggests lightspeed login first", async () => {
  const { models } = fauxModels(
    [fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" })],
    { id: "github-copilot", model: "gpt-5" },
  );

  await assert.rejects(
    () => call(models, [userMessage], "off", "github-copilot/gpt-5"),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "pi_auth_failed" &&
      error.suggestions[0]?.includes("lightspeed login github-copilot") === true &&
      error.suggestions.some((line) => line.includes("pi auth login")),
  );
});

test("a provider lightspeed cannot log in to keeps the env suggestion first", async () => {
  const { models } = fauxModels([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
  ]);

  await assert.rejects(
    () => call(models, [userMessage]),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "pi_auth_failed" &&
      !error.suggestions.some((line) => line.includes("lightspeed login")),
  );
});

test("a provider with no credentials at all reports pi_auth_missing", async () => {
  const { models } = fauxModels([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Provider is not configured: anthropic",
    }),
  ]);

  await assert.rejects(
    () => call(models, [userMessage]),
    (error: unknown) => error instanceof ReviewError && error.code === "pi_auth_missing",
  );
});
