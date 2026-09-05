import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassifyConfig } from "./classify.ts";
import { ReviewError } from "./errors.ts";
import { adoptFormerStateDir, expandHome } from "./paths.ts";

export const CONFIG_FILENAME = ".lightspeed.conf.json";

/** Pi's own `ModelThinkingLevel`. The no-thinking value is `off`, not `none`. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Whether review feedback is appended to the durable ledger. */
export const FEEDBACK_LOG_MODES = ["on", "off"] as const;

export type FeedbackLogMode = (typeof FEEDBACK_LOG_MODES)[number];

/** Allowlist, not free string: a typo'd api is a config error, not a mid-stream error. */
export const PROVIDER_APIS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "google-generative-ai",
] as const;

export type ProviderApi = (typeof PROVIDER_APIS)[number];

/**
 * One model, in pi's own `models.json` shape. Only `id` is required;
 * `thinkingLevelMap` and `compat` pass to pi-ai untouched.
 */
export interface ProviderModelConfig {
  id: string;
  name?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

/**
 * Provider entry keyed by pi provider id, in pi's `models.json` shape so entries paste
 * across. Deliberate difference: pi's `models: [...]` array is a single `model: {...}`
 * here — a review resolves exactly one model. A builtin id overrides that builtin
 * (endpoint/credential only; `name`, `api`, `model` refused); an unknown id builds a
 * whole provider and needs all three.
 */
export interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  api?: ProviderApi;
  apiKey?: string;
  headers?: Record<string, string>;
  model?: ProviderModelConfig;
}

export interface LightspeedConfig {
  model: string;
  thinking: ThinkingLevel;
  port: number;
  stateDir: string;
  feedbackLog: FeedbackLogMode;
  /**
   * Globs this repository adds to the file classifier's own rules. Always
   * present, empty lists included: the defaults are what a repository that
   * configures nothing gets, so "no globs" is a pair of empty lists rather
   * than an absence every reader has to handle.
   */
  classify: ClassifyConfig;
  /** Absent unless the config named providers: then pi-ai's builtins stand alone. */
  providers?: Record<string, ProviderConfig>;
}

const DEFAULTS = {
  port: 4388,
  stateDir: "~/.lightspeed",
  feedbackLog: "on",
} as const;

const CONFIG_KEYS: (keyof LightspeedConfig)[] = [
  "model",
  "thinking",
  "port",
  "stateDir",
  "feedbackLog",
  "classify",
  "providers",
];

const CLASSIFY_KEYS: (keyof ClassifyConfig)[] = ["mechanical", "guardrail"];

const PROVIDER_KEYS: (keyof ProviderConfig)[] = [
  "name",
  "baseUrl",
  "api",
  "apiKey",
  "headers",
  "model",
];

const PROVIDER_MODEL_KEYS: (keyof ProviderModelConfig)[] = [
  "id",
  "name",
  "baseUrl",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "thinkingLevelMap",
  "compat",
];

/**
 * Old-config keys: read, ignored, never validated. `groupingThreshold` decides
 * nothing now, but an upgrade must not fail on a config that names it.
 */
const RETIRED_KEYS = ["groupingThreshold"];

const KNOWN_KEYS: readonly string[] = [...CONFIG_KEYS, ...RETIRED_KEYS];

/** A pi provider id, as pi's own ids are written: `anthropic`, `google-vertex`. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** RFC 9110 token: what a header name may be made of. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The smallest config the loader accepts, and what `lightspeed init --config`
 * writes. `model` stays a placeholder on purpose: a plausible-looking default
 * would send a review at a model the user never chose and may not be able to
 * reach. One definition so the file written and the text telling you to write
 * it cannot say different things.
 */
export const STARTER_CONFIG: Pick<LightspeedConfig, "model" | "thinking"> = {
  model: "<provider/model>",
  thinking: "off",
};

const CREATE_HELP = `Create ${CONFIG_FILENAME} with {"model": "${STARTER_CONFIG.model}", "thinking": "${STARTER_CONFIG.thinking}"}`;

function invalid(message: string, detail?: string): ReviewError {
  return new ReviewError({
    code: "config_invalid",
    message,
    detail,
    suggestions: [CREATE_HELP],
  });
}

/**
 * Loads `.lightspeed.conf.json` from the repo root. No env vars, no silent
 * defaults for `model`/`thinking`: a bad config fails before any git/LLM work.
 */
export function loadConfig(repoRoot: string): LightspeedConfig {
  const raw = readConfigFile(join(repoRoot, CONFIG_FILENAME));
  rejectUnknownKeys(raw);
  const providers = readProviders(raw.providers);
  return {
    model: requireModel(raw.model),
    thinking: requireThinking(raw.thinking),
    port: readPort(raw.port),
    stateDir: resolveStateDir(raw.stateDir),
    feedbackLog: readFeedbackLog(raw.feedbackLog),
    classify: readClassify(raw.classify),
    ...(providers ? { providers } : {}),
  };
}

/**
 * The repository's own additions to `src/classify.ts`, which are additions and
 * never replacements: the defaults key on facts every project shares, and this
 * block is where the paths only this project knows about go. An absent block
 * and an empty one say the same thing, so both read as two empty lists.
 */
function readClassify(value: unknown): ClassifyConfig {
  if (value === undefined) return { mechanical: [], guardrail: [] };
  const raw = readObject(value, "classify");
  rejectUnknownNestedKeys(raw, CLASSIFY_KEYS, "classify");
  return {
    mechanical: readGlobs(raw.mechanical, "classify.mechanical"),
    guardrail: readGlobs(raw.guardrail, "classify.guardrail"),
  };
}

/**
 * An empty glob is refused rather than ignored: it matches nothing while
 * looking like a configured rule, which is the same silent-typo failure every
 * other check here exists to prevent.
 */
function readGlobs(value: unknown, key: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((glob) => typeof glob !== "string")) {
    throw invalid(
      `${CONFIG_FILENAME} key \`${key}\` must be an array of glob strings`,
      'example: ["docs/api/**"]',
    );
  }
  return (value as string[]).map((glob) => requireNonEmpty(glob, key));
}

/** Just the keys a ledger reader uses; `model` and `thinking` drive the LLM only. */
export interface LedgerConfig {
  stateDir: string;
  feedbackLog: FeedbackLogMode;
}

/**
 * Ledger is global across repos: needs no repository or config file, but a
 * config that exists is fully validated — a typo'd `stateDir` must not silently
 * send the reader to the default ledger.
 */
export function loadLedgerConfig(directory: string): LedgerConfig {
  const raw = readConfigFileIfAny(join(directory, CONFIG_FILENAME));
  rejectUnknownKeys(raw);
  return {
    stateDir: resolveStateDir(raw.stateDir),
    feedbackLog: readFeedbackLog(raw.feedbackLog),
  };
}

/**
 * State dir for callers with no config file. Same resolution as a loaded
 * config, adoption included, so every command lands in the same directory.
 */
export function defaultStateDir(): string {
  return resolveStateDir(undefined);
}

/** The one place a state dir is decided: the `lightspeed-review` rename is adopted whichever command runs first. */
function resolveStateDir(configured: unknown): string {
  const stateDir = expandHome(readString(configured, "stateDir") ?? DEFAULTS.stateDir);
  adoptFormerStateDir(stateDir);
  return stateDir;
}

function readConfigFile(path: string): Record<string, unknown> {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    throw new ReviewError({
      code: "config_missing",
      message: `${CONFIG_FILENAME} not found in repo root`,
      detail: "lightspeed requires explicit `model` and `thinking`",
      suggestions: [CREATE_HELP],
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw invalid(`${CONFIG_FILENAME} is not valid JSON`, (error as Error).message);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid(`${CONFIG_FILENAME} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** No config file is a valid state for a reader: the defaults describe it fully. */
function readConfigFileIfAny(path: string): Record<string, unknown> {
  return existsSync(path) ? readConfigFile(path) : {};
}

function rejectUnknownKeys(raw: Record<string, unknown>): void {
  const unknown = Object.keys(raw).filter((key) => !KNOWN_KEYS.includes(key));
  if (unknown.length > 0) {
    throw invalid(
      `${CONFIG_FILENAME} has unknown key(s): ${unknown.join(", ")}`,
      `known keys: ${CONFIG_KEYS.join(", ")}`,
    );
  }
}

function requireModel(value: unknown): string {
  const model = readString(value, "model");
  if (model === undefined || model.length === 0) {
    throw invalid(
      `${CONFIG_FILENAME} is missing required key \`model\``,
      "example: anthropic/claude-sonnet-4-5",
    );
  }
  return model;
}

function requireThinking(value: unknown): ThinkingLevel {
  const levels: readonly string[] = THINKING_LEVELS;
  if (typeof value !== "string" || !levels.includes(value)) {
    throw invalid(
      `${CONFIG_FILENAME} has a missing or invalid \`thinking\` level`,
      `valid values: ${THINKING_LEVELS.join(", ")}`,
    );
  }
  return value as ThinkingLevel;
}

function readFeedbackLog(value: unknown): FeedbackLogMode {
  if (value === undefined) return DEFAULTS.feedbackLog;
  const modes: readonly string[] = FEEDBACK_LOG_MODES;
  if (typeof value !== "string" || !modes.includes(value)) {
    throw invalid(
      `${CONFIG_FILENAME} has an invalid \`feedbackLog\` value`,
      `valid values: ${FEEDBACK_LOG_MODES.join(", ")}`,
    );
  }
  return value as FeedbackLogMode;
}

function readPort(value: unknown): number {
  const port = readCount(value, "port");
  if (port === undefined) return DEFAULTS.port;
  if (port < 1 || port > 65535) {
    throw invalid(`${CONFIG_FILENAME} has an out-of-range \`port\``, "valid values: 1-65535");
  }
  return port;
}

/**
 * All shape-checked here, before a request can carry a typo'd endpoint out.
 * Whole provider vs builtin override only the runtime knows: this reads the
 * shape, `src/llm/providers.ts` decides what it means.
 */
function readProviders(value: unknown): Record<string, ProviderConfig> | undefined {
  if (value === undefined) return undefined;
  const entries = Object.entries(readObject(value, "providers"));
  for (const [id] of entries) {
    if (!PROVIDER_ID.test(id)) {
      throw invalid(
        `${CONFIG_FILENAME} has a provider whose id is no provider id: \`${id}\``,
        "a provider key is a pi provider id: letters, digits, `.`, `-` and `_`, e.g. anthropic",
      );
    }
  }
  // fromEntries, not key assignment: an id like `__proto__` would set the prototype and vanish.
  return Object.fromEntries(entries.map(([id, entry]) => [id, readProvider(entry, id)]));
}

function readProvider(value: unknown, id: string): ProviderConfig {
  const raw = readObject(value, `providers.${id}`);
  rejectUnknownNestedKeys(raw, PROVIDER_KEYS, `providers.${id}`);
  return withoutAbsentKeys({
    name: readString(raw.name, `providers.${id}.name`),
    baseUrl: readUrl(raw.baseUrl, `providers.${id}.baseUrl`),
    api: readProviderApi(raw.api, id),
    apiKey: readApiKey(raw.apiKey, id),
    headers: readHeaders(raw.headers, id),
    model: readProviderModel(raw.model, id),
  });
}

/** Emptiness checked after expansion: a set-but-empty `${VAR}` is a missing credential too. */
function readApiKey(value: unknown, id: string): string | undefined {
  const apiKey = readString(value, `providers.${id}.apiKey`);
  if (apiKey === undefined) return undefined;
  return requireNonEmpty(expandVariables(apiKey, id, "apiKey"), `providers.${id}.apiKey`);
}

/**
 * pi-ai reads `baseUrl` for truthiness: an empty one silently sends requests to
 * the vendor URL the entry exists to replace.
 */
function readUrl(value: unknown, key: string): string | undefined {
  const url = readString(value, key);
  return url === undefined ? undefined : requireNonEmpty(url, key);
}

function requireNonEmpty(value: string, key: string): string {
  if (value.length === 0) {
    throw invalid(`${CONFIG_FILENAME} key \`${key}\` must not be empty`);
  }
  return value;
}

function readProviderApi(value: unknown, id: string): ProviderApi | undefined {
  if (value === undefined) return undefined;
  const apis: readonly string[] = PROVIDER_APIS;
  if (typeof value !== "string" || !apis.includes(value)) {
    throw invalid(
      `${CONFIG_FILENAME} provider \`${id}\` has an unsupported \`api\``,
      `valid values: ${PROVIDER_APIS.join(", ")}`,
    );
  }
  return value as ProviderApi;
}

/**
 * CR/LF/NUL in a value is header injection, and fetch rejects it by quoting the
 * value back — leaking an expanded secret to stdout and CI logs. `${VAR}` values
 * often end in a newline, so the error names the header, never the value.
 */
function readHeaders(value: unknown, id: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const raw = readObject(value, `providers.${id}.headers`);
  return Object.fromEntries(
    Object.entries(raw).map(([header, headerValue]) => {
      const where = `providers.${id}.headers.${header}`;
      if (!HEADER_NAME.test(header)) {
        throw invalid(
          `${CONFIG_FILENAME} provider \`${id}\` has a header name that is no HTTP token`,
          "a header name is letters, digits and `!#$%&'*+-.^_`|~`",
        );
      }
      if (typeof headerValue !== "string") {
        throw invalid(`${CONFIG_FILENAME} key \`${where}\` must be a string`);
      }
      const expanded = expandVariables(headerValue, id, `headers.${header}`);
      if (/[\r\n\0]/.test(expanded)) {
        throw invalid(
          `${CONFIG_FILENAME} provider \`${id}\` has a line break or a NUL in header \`${header}\``,
          "a header value is one line; an environment variable read from a file often ends in a newline",
        );
      }
      return [header, expanded];
    }),
  );
}

function readProviderModel(value: unknown, id: string): ProviderModelConfig | undefined {
  if (value === undefined) return undefined;
  const where = `providers.${id}.model`;
  const raw = readObject(value, where);
  rejectUnknownNestedKeys(raw, PROVIDER_MODEL_KEYS, where);
  const modelId = readString(raw.id, `${where}.id`);
  if (modelId === undefined || modelId.length === 0) {
    throw invalid(
      `${CONFIG_FILENAME} provider \`${id}\` has a \`model\` without an \`id\``,
      'example: {"id": "gpt-5"}',
    );
  }
  return withoutAbsentKeys({
    id: modelId,
    name: readString(raw.name, `${where}.name`),
    baseUrl: readUrl(raw.baseUrl, `${where}.baseUrl`),
    reasoning: readBoolean(raw.reasoning, `${where}.reasoning`),
    input: readModelInput(raw.input, where),
    cost: readModelCost(raw.cost, where),
    contextWindow: readCount(raw.contextWindow, `${where}.contextWindow`),
    maxTokens: readCount(raw.maxTokens, `${where}.maxTokens`),
    thinkingLevelMap: readObjectIfAny(raw.thinkingLevelMap, `${where}.thinkingLevelMap`),
    compat: readObjectIfAny(raw.compat, `${where}.compat`),
  });
}

/** Absent keys omitted, not `undefined`: a loaded config deep-equals its JSON. */
function withoutAbsentKeys<T extends object>(entries: T): T {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as T;
}

function readModelInput(value: unknown, where: string): ("text" | "image")[] | undefined {
  if (value === undefined) return undefined;
  const modalities = ["text", "image"];
  if (!Array.isArray(value) || value.some((entry) => !modalities.includes(entry as string))) {
    throw invalid(`${CONFIG_FILENAME} key \`${where}.input\` must be an array of "text"/"image"`);
  }
  return value as ("text" | "image")[];
}

function readModelCost(value: unknown, where: string): ProviderModelConfig["cost"] {
  if (value === undefined) return undefined;
  const raw = readObject(value, `${where}.cost`);
  const rates = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const unknown = Object.keys(raw).filter((key) => !rates.includes(key as (typeof rates)[number]));
  if (unknown.length > 0) {
    throw invalid(
      `${CONFIG_FILENAME} key \`${where}.cost\` has unknown key(s): ${unknown.join(", ")}`,
      `known keys: ${rates.join(", ")}`,
    );
  }
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const rate of rates) {
    cost[rate] = readRate(raw[rate], `${where}.cost.${rate}`) ?? cost[rate];
  }
  return cost;
}

function readRate(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid(`${CONFIG_FILENAME} key \`${key}\` must be a non-negative number`);
  }
  return value;
}

/**
 * `${VAR}` expansion in `apiKey` and header values only: the config is committed,
 * so it names the variable a secret lives in, never the secret (pi takes these
 * literally). Unset variable = config error, not an empty credential the provider
 * later rejects as a bad key. A bare `$` is a character like any other.
 */
function expandVariables(value: string, providerId: string, where: string): string {
  return value.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw invalid(
        `${CONFIG_FILENAME} provider \`${providerId}\` has a \`\${}\` with no usable variable name`,
        `it is written in \`providers.${providerId}.${where}\``,
      );
    }
    const resolved = process.env[name];
    if (resolved === undefined) {
      throw invalid(
        `${CONFIG_FILENAME} provider \`${providerId}\` needs environment variable \`${name}\`, which is not set`,
        `it is referenced by \`providers.${providerId}.${where}\``,
      );
    }
    return resolved;
  });
}

function rejectUnknownNestedKeys(
  raw: Record<string, unknown>,
  known: readonly string[],
  where: string,
): void {
  const unknown = Object.keys(raw).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw invalid(
      `${CONFIG_FILENAME} key \`${where}\` has unknown key(s): ${unknown.join(", ")}`,
      `known keys: ${known.join(", ")}`,
    );
  }
}

function readObjectIfAny(value: unknown, key: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : readObject(value, key);
}

function readObject(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${CONFIG_FILENAME} key \`${key}\` must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw invalid(`${CONFIG_FILENAME} key \`${key}\` must be a boolean`);
  }
  return value;
}

function readString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw invalid(`${CONFIG_FILENAME} key \`${key}\` must be a string`);
  }
  return value;
}

function readCount(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalid(`${CONFIG_FILENAME} key \`${key}\` must be a non-negative integer`);
  }
  return value;
}
