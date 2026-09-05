import { contentText, createModels } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  Models,
  MutableModels,
} from "@earendil-works/pi-ai";
import type { ProviderConfig, ThinkingLevel } from "../config.ts";
import {
  LOGIN_PROVIDERS,
  layeredCredentialStore,
  lightspeedAuthStore,
  piAuthStore,
} from "./pi-auth.ts";
import { loadPiProviders } from "./pi-models.ts";
import { applyConfiguredProviders, applyPiProviders } from "./providers.ts";
import { ReviewError, type ReviewErrorCode } from "../errors.ts";

export interface GroupingCallInput {
  /** `provider/model-id`, exactly as written in `.lightspeed.conf.json`. */
  model: string;
  thinking: ThinkingLevel;
  /** The providers `.lightspeed.conf.json` names, layered over pi-ai's builtins. */
  providers?: Record<string, ProviderConfig>;
  /** The config's state dir, where `lightspeed login` keeps its own credentials. */
  stateDir: string;
  systemPrompt: string;
  /** Conversation so far; the reply is appended to it in the result. */
  messages: Message[];
  /** Injected in tests. Defaults to every built-in pi-ai provider. */
  models?: MutableModels;
  signal?: AbortSignal;
}

export interface GroupingCallResult {
  text: string;
  /** `input.messages` plus the assistant reply, ready for a repair round. */
  messages: Message[];
}

/**
 * One in-process pi-ai request. Grouping owns the prompts; this module only
 * resolves the configured model, runs the call and turns pi-ai's error-carrying
 * reply into a structured ReviewError.
 */
export async function runGroupingCall(input: GroupingCallInput): Promise<GroupingCallResult> {
  const models = input.models ?? (await builtinModels(input.stateDir));
  applyConfiguredProviders(models, input.providers);
  const model = resolveModel(models, input.model);
  const reply = await models.completeSimple(
    model,
    {
      systemPrompt: input.systemPrompt,
      messages: input.messages,
    },
    {
      ...(input.thinking === "off" ? {} : { reasoning: input.thinking }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
  rejectFailedReply(reply, input);
  return { text: contentText(reply.content), messages: [...input.messages, reply] };
}

/**
 * Every builtin provider, authenticated the way this machine already is:
 * lightspeed's logins, then pi's credential file, then env vars. An install
 * that ran `lightspeed login` or can run `pi` needs no further setup.
 */
async function builtinModels(stateDir: string): Promise<MutableModels> {
  const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
  const credentials = layeredCredentialStore(lightspeedAuthStore(stateDir), piAuthStore());
  const models = createModels({ credentials });
  for (const provider of builtinProviders()) models.setProvider(provider);
  applyPiProviders(models, loadPiProviders());
  return models;
}

function resolveModel(models: Models, reference: string): Model<Api> {
  const separator = reference.indexOf("/");
  const providerId = separator === -1 ? "" : reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  const model = providerId === "" ? undefined : models.getModel(providerId, modelId);
  if (!model) {
    throw piError("pi_model_unknown", `unknown model \`${reference}\``, {
      detail: "`model` must be `<provider>/<model-id>`, e.g. anthropic/claude-sonnet-4-5",
    });
  }
  return model;
}

/** pi-ai never throws for request failures — it returns a message with an error stop reason. */
function rejectFailedReply(reply: AssistantMessage, input: GroupingCallInput): void {
  if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return;
  const reference = input.model;
  const detail = reply.errorMessage ?? `stopped with reason ${reply.stopReason}`;
  const endpoint = configuredEndpoint(input);
  if (reply.stopReason === "error") throw authError(detail, reference, endpoint);
  throw piError("pi_stream_failed", `the grouping request to \`${reference}\` failed`, {
    detail,
    endpoint,
  });
}

/**
 * The config's own endpoint, when it named one: a down proxy reads as any other
 * network failure, and the reviewer would never learn where the request really
 * went. The URL is the one non-secret part of a provider entry — key and
 * headers stay out of every message.
 */
function configuredEndpoint(input: GroupingCallInput): string | undefined {
  const providerId = input.model.slice(0, input.model.indexOf("/"));
  const baseUrl = input.providers?.[providerId]?.baseUrl;
  return baseUrl === undefined
    ? undefined
    : `Check that ${baseUrl} is reachable — it is \`providers.${providerId}.baseUrl\` in .lightspeed.conf.json`;
}

/**
 * Which of the three ways a request can fail this one is: no credential at all,
 * a credential the provider rejected, or anything else.
 */
function authError(detail: string, reference: string, endpoint?: string): ReviewError {
  if (looksUnconfigured(detail)) {
    return piError("pi_auth_missing", `no credentials for the provider behind \`${reference}\``, {
      detail,
      endpoint,
      suggestions: withLoginSuggestion(reference, [
        "Export the provider's credential, e.g. `export ANTHROPIC_OAUTH_TOKEN=…` or `export ANTHROPIC_API_KEY=…`",
        "Then re-run `lightspeed start <branch> [base]`",
      ]),
    });
  }
  if (looksLikeAuthFailure(detail)) {
    return piError("pi_auth_failed", `\`${reference}\` rejected the request as unauthenticated`, {
      detail,
      endpoint,
      suggestions: withLoginSuggestion(reference, [
        "Authenticate the provider: `pi auth login <provider>` for one pi knows, or `providers.<id>.apiKey`/`headers` in .lightspeed.conf.json",
        "Then re-run `lightspeed start <branch> [base]`",
      ]),
    });
  }
  return piError("pi_stream_failed", `the grouping request to \`${reference}\` failed`, {
    detail,
    endpoint,
  });
}

/**
 * The one-command fix goes first, when there is one: the three subscription
 * providers lightspeed can sign itself into. Everyone else keeps the env and
 * config routes unshifted.
 */
function withLoginSuggestion(
  reference: string,
  rest: [string, ...string[]],
): [string, ...string[]] {
  const providerId = reference.split("/")[0] ?? "";
  const supported: readonly string[] = LOGIN_PROVIDERS;
  if (!supported.includes(providerId)) return rest;
  return [
    `Run \`lightspeed login ${providerId}\` once, in your own terminal — it is human-run, never an agent's`,
    ...rest,
  ];
}

/**
 * No credential was found at all, as opposed to one the provider rejected.
 * pi-ai reads credentials from the environment only, so this means nothing was
 * exported — a setup mistake the reviewer must be told about, not a bad key.
 */
function looksUnconfigured(message: string): boolean {
  return /\bnot configured\b|\bno (api[ _-]?key|credential)/i.test(message);
}

function looksLikeAuthFailure(message: string): boolean {
  return /\bapi[ _-]?key\b|unauthori[sz]ed|forbidden|credential|\b401\b|\b403\b/i.test(message);
}

function piError(
  code: ReviewErrorCode,
  message: string,
  options: { detail: string; suggestions?: [string, ...string[]]; endpoint?: string },
): ReviewError {
  const suggestions: [string, ...string[]] = options.suggestions ?? [
    "Check `model` and `thinking` in .lightspeed.conf.json",
    "Then re-run `lightspeed start <branch> [base]`",
  ];
  return new ReviewError({
    code,
    message,
    detail: options.detail,
    suggestions: options.endpoint ? [options.endpoint, ...suggestions] : suggestions,
  });
}
