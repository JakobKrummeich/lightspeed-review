import type {
  AuthResult,
  ModelAuth,
  Provider,
  ProviderAuth,
  ProviderHeaders,
} from "@earendil-works/pi-ai";
import { CONFIG_FILENAME } from "../config.ts";
import { ReviewError } from "../errors.ts";
import { resolvePiConfigValue, type PiProviderConfig } from "./pi-models.ts";
import { mergeHeaders } from "./provider-headers.ts";

type EnvLookup = (name: string) => Promise<string | undefined>;

/** Pi's models.json only supplies a key when Pi has no stored/runtime credential. */
export function overridePiBuiltin(
  builtin: Provider,
  id: string,
  config: PiProviderConfig,
): Provider {
  const apiKey = builtin.auth.apiKey;
  const oauth = builtin.auth.oauth;
  return {
    ...builtin,
    auth: {
      ...(apiKey
        ? {
            apiKey: {
              ...apiKey,
              resolve: async (input) => {
                const resolved = await apiKey.resolve(input);
                return layerPiResult(
                  resolved,
                  id,
                  config,
                  piEnvironment(input.ctx.env, { ...input.credential?.env, ...resolved?.env }),
                );
              },
            },
          }
        : {}),
      ...(oauth
        ? {
            oauth: {
              ...oauth,
              toAuth: async (credential) =>
                layerPiAuth(await oauth.toAuth(credential), id, config, piEnvironment()),
            },
          }
        : {}),
    },
  };
}

/** Authentication for a Pi-defined provider that pi-ai did not ship. */
export function piProviderAuth(id: string, config: PiProviderConfig): ProviderAuth {
  return {
    apiKey: {
      name: `${config.name ?? id} API key`,
      resolve: async (input) => {
        const environment = piEnvironment(input.ctx.env, input.credential?.env);
        const apiKey = input.credential?.key ?? (await piApiKey(id, config, environment));
        return {
          auth: await layerPiAuth(
            { ...(apiKey === undefined ? {} : { apiKey }) },
            id,
            config,
            environment,
          ),
          source: CONFIG_FILENAME,
        };
      },
    },
  };
}

async function layerPiResult(
  resolved: AuthResult | undefined,
  id: string,
  config: PiProviderConfig,
  environment: EnvLookup,
): Promise<AuthResult | undefined> {
  if (resolved)
    return { ...resolved, auth: await layerPiAuth(resolved.auth, id, config, environment) };
  const apiKey = await piApiKey(id, config, environment);
  if (apiKey === undefined) return undefined;
  return { auth: await layerPiAuth({ apiKey }, id, config, environment), source: CONFIG_FILENAME };
}

async function layerPiAuth(
  auth: ModelAuth,
  id: string,
  config: PiProviderConfig,
  environment: EnvLookup,
): Promise<ModelAuth> {
  const headers = piAuthHeaders(auth, id, config, await piHeaders(id, config.headers, environment));
  return {
    ...auth,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    ...(headers === undefined ? {} : { headers }),
  };
}

async function piApiKey(
  id: string,
  config: PiProviderConfig,
  environment: EnvLookup,
): Promise<string | undefined> {
  if (config.apiKey === undefined) return undefined;
  return requirePiValue(await resolvePiConfigValue(config.apiKey, environment), id, "apiKey");
}

async function piHeaders(
  id: string,
  headers: Record<string, string> | undefined,
  environment: EnvLookup,
): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  return Object.fromEntries(
    await Promise.all(
      Object.entries(headers).map(async ([name, value]) => [
        name,
        requirePiValue(await resolvePiConfigValue(value, environment), id, `header \`${name}\``),
      ]),
    ),
  );
}

function piAuthHeaders(
  auth: ModelAuth,
  id: string,
  config: PiProviderConfig,
  configured: Record<string, string> | undefined,
): ProviderHeaders | undefined {
  const headers = configured === undefined ? auth.headers : mergeHeaders(auth.headers, configured);
  if (!config.authHeader) return headers;
  if (!auth.apiKey) {
    throw new ReviewError({
      code: "config_invalid",
      message: `Pi provider \`${id}\` enables authHeader without an apiKey`,
      detail: "Configure a stored credential or models.json apiKey for this provider.",
      suggestions: ["Fix the Pi provider configuration, then re-run lightspeed."],
    });
  }
  return mergeHeaders(headers, { Authorization: `Bearer ${auth.apiKey}` });
}

function requirePiValue(value: string | undefined, id: string, source: string): string {
  if (value !== undefined) return value;
  throw new ReviewError({
    code: "config_invalid",
    message: `Pi provider \`${id}\` could not resolve its ${source}`,
    detail: "Check ~/.pi/agent/models.json and its referenced environment variables or command.",
    suggestions: ["Fix the Pi provider configuration, then re-run lightspeed."],
  });
}

function piEnvironment(
  context?: (name: string) => Promise<string | undefined>,
  explicit?: Record<string, string>,
): EnvLookup {
  return async (name) =>
    explicit?.[name] || (await context?.(name)) || process.env[name] || undefined;
}
