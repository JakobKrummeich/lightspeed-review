import type { ProviderHeaders } from "@earendil-works/pi-ai";

/**
 * Layers configured headers over the ones a provider already carries, for both
 * paths that do it: a config-defined provider (`providers.ts`) and a Pi-defined
 * one (`pi-provider-auth.ts`, which also sends the resolved key this way).
 *
 * `override` wins, and it wins under whatever spelling the base used: HTTP
 * header names are case-insensitive, so a plain spread would leave
 * `Authorization` beside `authorization` and ship both. Only the base can hold
 * a `null` — pi-ai's "suppress this header" — so a merged null is always a base
 * header nothing replaced.
 */
export function mergeHeaders(
  base: ProviderHeaders | undefined,
  override: Record<string, string>,
): ProviderHeaders {
  const merged = { ...base };
  for (const [name, value] of Object.entries(override)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing];
    }
    merged[name] = value;
  }
  return merged;
}
