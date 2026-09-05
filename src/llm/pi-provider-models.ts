import type { Api, Model } from "@earendil-works/pi-ai";
import { ReviewError } from "../errors.ts";
import {
  resolvePiStaticHeaders,
  type PiModelOverride,
  type PiProviderConfig,
  type PiProviderModelConfig,
} from "./pi-models.ts";

const PI_MODEL_DEFAULTS = {
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
} as const;

/** Builds Pi models without leaking one model's optional fields into another. */
export function piModels(
  id: string,
  baseModels: readonly Model<Api>[],
  config: PiProviderConfig,
): Model<Api>[] {
  const models: Model<Api>[] = baseModels.map(
    (model) =>
      ({
        ...model,
        ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
        compat: mergeCompat(model.compat, config.compat),
      }) as Model<Api>,
  );
  for (const definition of config.models ?? []) {
    const existingIndex = models.findIndex((model) => model.id === definition.id);
    const existing = existingIndex === -1 ? undefined : models[existingIndex];
    const model = modelFromPiConfig(id, definition, config, existing, existing ?? models[0]);
    if (existingIndex === -1) models.push(model);
    else models[existingIndex] = model;
  }
  return models.map((model) => applyPiModelOverride(id, model, config.modelOverrides?.[model.id]));
}

function modelFromPiConfig(
  provider: string,
  definition: PiProviderModelConfig,
  config: PiProviderConfig,
  defaults: Model<Api> | undefined,
  locationDefaults: Model<Api> | undefined,
): Model<Api> {
  const { api, baseUrl } = piModelLocation(definition, config, locationDefaults);
  if (!api || !baseUrl) throw piProviderError(provider, definition.id, "api and baseUrl");
  return {
    ...PI_MODEL_DEFAULTS,
    ...defaults,
    ...definition,
    id: definition.id,
    name: definition.name ?? definition.id,
    provider,
    api,
    baseUrl,
    compat: mergeCompat(mergeCompat(defaults?.compat, config.compat), definition.compat),
    headers: resolvePiModelHeaders(provider, definition.id, definition.headers),
  } as Model<Api>;
}

function piModelLocation(
  definition: PiProviderModelConfig,
  config: PiProviderConfig,
  defaults: Model<Api> | undefined,
): { api: Api | undefined; baseUrl: string | undefined } {
  return {
    api: definition.api ?? config.api ?? defaults?.api,
    baseUrl: definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl,
  };
}

function applyPiModelOverride(
  provider: string,
  model: Model<Api>,
  override: PiModelOverride | undefined,
): Model<Api> {
  if (!override) return model;
  const { cost, compat, headers, thinkingLevelMap, ...values } = override;
  return {
    ...model,
    ...values,
    id: model.id,
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    cost: cost === undefined ? model.cost : { ...model.cost, ...cost },
    thinkingLevelMap:
      thinkingLevelMap === undefined
        ? model.thinkingLevelMap
        : { ...model.thinkingLevelMap, ...thinkingLevelMap },
    compat: mergeCompat(model.compat, compat),
    headers:
      headers === undefined
        ? model.headers
        : { ...model.headers, ...resolvePiModelHeaders(provider, model.id, headers) },
  } as Model<Api>;
}

function resolvePiModelHeaders(
  provider: string,
  model: string,
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved = resolvePiStaticHeaders(headers);
  if (resolved === undefined) throw piProviderError(provider, model, "header environment value");
  return resolved;
}

function mergeCompat(
  base: Model<Api>["compat"] | Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return override === undefined
    ? (base as Record<string, unknown> | undefined)
    : { ...base, ...override };
}

function piProviderError(provider: string, model: string, missing: string): ReviewError {
  return new ReviewError({
    code: "config_invalid",
    message: `Pi provider \`${provider}\` model \`${model}\` needs ${missing}`,
    detail:
      "Pi custom models need an api and baseUrl on the model, provider, or an existing builtin model.",
    suggestions: ["Fix ~/.pi/agent/models.json, then re-run lightspeed."],
  });
}
