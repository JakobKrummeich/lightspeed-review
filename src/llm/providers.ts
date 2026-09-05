import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import type {
  Api,
  AuthResult,
  Model,
  ModelAuth,
  MutableModels,
  Provider,
  ProviderStreams,
} from "@earendil-works/pi-ai";
import { CONFIG_FILENAME, type ProviderApi, type ProviderConfig } from "../config.ts";
import { piModels } from "./pi-provider-models.ts";
import type { PiProviderConfig } from "./pi-models.ts";
import { overridePiBuiltin, piProviderAuth } from "./pi-provider-auth.ts";
import { mergeHeaders } from "./provider-headers.ts";
import { ReviewError } from "../errors.ts";

const API_STREAMS: Record<string, () => ProviderStreams> = {
  "anthropic-messages": anthropicMessagesApi,
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "azure-openai-responses": azureOpenAIResponsesApi,
  "openai-codex-responses": openAICodexResponsesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "google-vertex": googleVertexApi,
  "mistral-conversations": mistralConversationsApi,
  "bedrock-converse-stream": bedrockConverseStreamApi,
  "pi-messages": piMessagesApi,
};

const MODEL_DEFAULTS = {
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 16384,
} as const;

type ProviderAuthConfig = Pick<ProviderConfig, "apiKey" | "baseUrl" | "headers">;

/** Layer repository providers over whatever Pi and pi-ai already supplied. */
export function applyConfiguredProviders(
  models: MutableModels,
  providers: Record<string, ProviderConfig> | undefined,
): void {
  for (const [id, config] of Object.entries(providers ?? {})) {
    const builtin = models.getProvider(id);
    if (!builtin) {
      models.setProvider(customProvider(id, config));
      continue;
    }
    rejectWholeProviderKeys(id, config);
    models.setProvider(overrideBuiltin(builtin, config));
  }
}

/** Layer Pi providers over pi-ai's builtins; repository providers run afterward and win. */
export function applyPiProviders(
  models: MutableModels,
  providers: Record<string, PiProviderConfig>,
): void {
  for (const [id, config] of Object.entries(providers)) {
    const builtin = models.getProvider(id);
    const catalog = piModels(id, builtin?.getModels() ?? [], config);
    if (builtin) {
      models.setProvider({ ...overridePiBuiltin(builtin, id, config), getModels: () => catalog });
    } else {
      models.setProvider(configuredProvider(id, config, catalog, piProviderAuth(id, config)));
    }
  }
}

function rejectWholeProviderKeys(id: string, config: ProviderConfig): void {
  const ignored = (["name", "api", "model"] as const).filter((key) => config[key] !== undefined);
  if (ignored.length === 0) return;
  throw new ReviewError({
    code: "config_invalid",
    message: `${CONFIG_FILENAME} provider \`${id}\` overrides a provider pi-ai ships, so \`${ignored.join("`, `")}\` would decide nothing`,
    detail:
      "an override may set `baseUrl`, `apiKey` and `headers`; the models, the api and the name stay the builtin's",
    suggestions: [
      `Drop \`${ignored.join("`, `")}\` from \`providers.${id}\`, or give the provider an id pi-ai does not ship`,
    ],
  });
}

function overrideBuiltin(builtin: Provider, config: ProviderAuthConfig): Provider {
  const apiKey = builtin.auth.apiKey;
  const oauth = builtin.auth.oauth;
  return {
    ...builtin,
    auth: {
      ...(apiKey
        ? {
            apiKey: {
              ...apiKey,
              resolve: async (input) => layerOnResult(await apiKey.resolve(input), config),
            },
          }
        : {}),
      ...(oauth
        ? {
            oauth: {
              ...oauth,
              toAuth: async (credential) => layerOnAuth(await oauth.toAuth(credential), config),
            },
          }
        : {}),
    },
  };
}

function layerOnResult(
  resolved: AuthResult | undefined,
  config: ProviderAuthConfig,
): AuthResult | undefined {
  if (!resolved) {
    return config.apiKey === undefined
      ? undefined
      : { auth: layerOnAuth({ apiKey: config.apiKey }, config), source: CONFIG_FILENAME };
  }
  return { ...resolved, auth: layerOnAuth(resolved.auth, config) };
}

function layerOnAuth(auth: ModelAuth, config: ProviderAuthConfig): ModelAuth {
  return {
    ...auth,
    ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(config.headers === undefined
      ? {}
      : { headers: mergeHeaders(auth.headers, config.headers) }),
  };
}

function customProvider(id: string, config: ProviderConfig): Provider {
  const api = requireProviderKey(config.api, id, "api");
  const model = requireProviderKey(config.model, id, "model");
  const baseUrl = requireProviderKey(model.baseUrl ?? config.baseUrl, id, "baseUrl");
  return configuredProvider(id, config, [modelFromConfig(id, model, api, baseUrl, MODEL_DEFAULTS)]);
}

function configuredProvider(
  id: string,
  config: ProviderAuthConfig & Pick<PiProviderConfig, "name">,
  catalog: Model<Api>[],
  auth?: Provider["auth"],
): Provider {
  const api = Object.fromEntries(
    [...new Set(catalog.map((model) => model.api))].map((name) => [name, streamsFor(name, id)]),
  ) as Partial<Record<Api, ProviderStreams>>;
  return createProvider({
    id,
    name: config.name ?? id,
    auth: auth ?? {
      apiKey: {
        name: `${config.name ?? id} API key`,
        resolve: async () => ({ auth: layerOnAuth({}, config), source: CONFIG_FILENAME }),
      },
    },
    models: catalog,
    api,
  });
}

function modelFromConfig(
  provider: string,
  model: NonNullable<ProviderConfig["model"]>,
  api: ProviderApi,
  baseUrl: string,
  defaults: typeof MODEL_DEFAULTS,
): Model<Api> {
  return {
    ...defaults,
    ...model,
    name: model.name ?? model.id,
    provider,
    api,
    baseUrl,
  } as Model<Api>;
}

function streamsFor(api: Api, providerId: string): ProviderStreams {
  const streams = API_STREAMS[api];
  if (streams) return streams();
  throw new ReviewError({
    code: "config_invalid",
    message: `Pi provider \`${providerId}\` uses unsupported api \`${api}\``,
    detail: `supported APIs: ${Object.keys(API_STREAMS).join(", ")}`,
    suggestions: ["Choose an API that this installed pi-ai version supports."],
  });
}

function requireProviderKey<T>(value: T | undefined, id: string, key: string): T {
  if (value !== undefined) return value;
  throw new ReviewError({
    code: "config_invalid",
    message: `${CONFIG_FILENAME} provider \`${id}\` is unknown to pi and has no \`${key}\``,
    detail: `a provider pi-ai does not ship needs \`api\`, \`baseUrl\` and \`model.id\``,
    suggestions: [`Add \`${key}\` to \`providers.${id}\` in ${CONFIG_FILENAME}`],
  });
}
