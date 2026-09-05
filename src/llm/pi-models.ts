import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Pi's user-owned provider configuration. It never belongs in a repository. */
export interface PiProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: Api;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: PiProviderModelConfig[];
  modelOverrides?: Record<string, PiModelOverride>;
}

export interface PiProviderModelConfig {
  id: string;
  name?: string;
  api?: Api;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input?: ("text" | "image")[];
  cost?: Model<Api>["cost"];
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

export type PiModelOverride = Omit<
  Partial<PiProviderModelConfig>,
  "id" | "api" | "baseUrl" | "cost"
> & { cost?: Partial<NonNullable<PiProviderModelConfig["cost"]>> };

export function piModelsPath(): string {
  return join(homedir(), ".pi", "agent", "models.json");
}

/**
 * Reads Pi's JSONC file at request time. Invalid or absent config is Pi's
 * normal "no custom providers" state; request setup still has builtins/auth/env.
 */
export function loadPiProviders(path = piModelsPath()): Record<string, PiProviderConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return {};
    return Object.fromEntries(
      Object.entries(parsed.providers).filter((entry): entry is [string, PiProviderConfig] =>
        isRecord(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

const PI_VALUE_TOKEN = /\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** One piece of a Pi config value: text to keep as it stands, or a name to look up. */
type PiValuePart = { literal: string } | { variable: string };

/**
 * Pi's value grammar, parsed in one place for both resolvers below. They may
 * differ in where a name is looked up — a stored credential's environment, or
 * this process's — and in nothing else. Held together because the grammar was
 * written out twice: the day it grows a token, one copy would keep the old
 * reading, and since the two serve different fields (provider credentials
 * against model headers) the same config would resolve for one and be reported
 * as the other one's fault.
 */
function piValueParts(value: string): PiValuePart[] {
  const parts: PiValuePart[] = [];
  let end = 0;
  for (const match of value.matchAll(PI_VALUE_TOKEN)) {
    const token = match[0];
    const name = match[1] ?? match[2];
    parts.push({ literal: value.slice(end, match.index) });
    // `$$` and `$!` stand for the character after the `$`: an escape, not a name.
    parts.push(name === undefined ? { literal: token.slice(1) } : { variable: name });
    end = (match.index ?? 0) + token.length;
  }
  parts.push({ literal: value.slice(end) });
  return parts;
}

/** Pi's apiKey/header value syntax: `$NAME`, `${NAME}`, `$$`, `$!`, or `!command`. */
export async function resolvePiConfigValue(
  value: string,
  lookup: (name: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (value.startsWith("!")) return resolvePiCommand(value);
  let resolved = "";
  for (const part of piValueParts(value)) {
    if ("literal" in part) {
      resolved += part.literal;
      continue;
    }
    // A name nobody can answer voids the whole value, and voids it here: the
    // rest is not looked up, and half a credential is never handed onward.
    const replacement = await lookup(part.variable);
    if (replacement === undefined) return undefined;
    resolved += replacement;
  }
  return resolved;
}

/** The same syntax where only this process's environment can answer. */
export function resolvePiStaticConfigValue(value: string): string | undefined {
  if (value.startsWith("!")) return resolvePiCommand(value);
  let resolved = "";
  for (const part of piValueParts(value)) {
    if ("literal" in part) {
      resolved += part.literal;
      continue;
    }
    const replacement = process.env[part.variable];
    if (replacement === undefined) return undefined;
    resolved += replacement;
  }
  return resolved;
}

export function resolvePiStaticHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved = Object.entries(headers).map(([name, value]) => [
    name,
    resolvePiStaticConfigValue(value),
  ]);
  if (resolved.some(([, value]) => value === undefined)) return undefined;
  return Object.fromEntries(resolved as [string, string][]);
}

function resolvePiCommand(value: string): string | undefined {
  try {
    return (
      execSync(value.slice(1), {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Pi accepts JSONC; quoted URLs and values remain untouched. */
function stripJsonComments(input: string): string {
  return input.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) =>
    match.startsWith('"') ? match : "",
  );
}
