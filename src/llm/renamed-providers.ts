import { CONFIG_FILENAME, type LightspeedConfig } from "../config.ts";

/**
 * Provider ids pi-ai renamed, old → current. pi-ai 1.0.3 renamed
 * `azure-openai-responses` to `azure` and migrates nothing: pi tells its users
 * to rename the key in auth.json and models.json by hand. Until they have, the
 * old id keeps working here — a review should not lose its grouping, or its
 * credential, over a rename the user never made. Only the provider id moved:
 * the *api* `azure-openai-responses` (config.ts `PROVIDER_APIS`) is unchanged.
 * A Map, not an object literal: `constructor` and friends must not resolve.
 */
export const RENAMED_PROVIDERS: ReadonlyMap<string, string> = new Map([
  ["azure-openai-responses", "azure"],
]);

/** The id pi-ai knows today for a provider id written under either name. */
export function currentProviderId(id: string): string {
  return RENAMED_PROVIDERS.get(id) ?? id;
}

/** The old id a credential for `id` may still be stored under, if it was renamed. */
export function legacyProviderId(id: string): string | undefined {
  for (const [legacy, current] of RENAMED_PROVIDERS) if (current === id) return legacy;
  return undefined;
}

/**
 * Provider entries keyed by current ids. An entry under the current id beats one
 * under the old id, whatever order the file wrote them in: the current one is
 * what the user wrote after the rename, the old one what they forgot to delete.
 */
export function withCurrentProviderIds<T>(entries: Record<string, T>): Record<string, T> {
  const current = Object.entries(entries).filter(([id]) => !RENAMED_PROVIDERS.has(id));
  const renamed = Object.entries(entries)
    .filter(([id]) => RENAMED_PROVIDERS.has(id) && !(currentProviderId(id) in entries))
    .map(([id, entry]): [string, T] => [currentProviderId(id), entry]);
  return Object.fromEntries([...current, ...renamed]);
}

/**
 * A help line per old id in the repository's config: it still works, so this
 * is advice riding along with a review that opened, not an error. pi's own
 * auth.json and models.json get none — they are pi's files, and pi's changelog
 * already tells the user to rename them.
 */
export function renamedProviderHelp(
  config: Pick<LightspeedConfig, "model" | "providers">,
): string[] {
  return [...modelHelp(config.model), ...providersHelp(config.providers ?? {})];
}

function modelHelp(model: string): string[] {
  const legacy = model.slice(0, Math.max(model.indexOf("/"), 0));
  const current = RENAMED_PROVIDERS.get(legacy);
  if (current === undefined) return [];
  const renamed = `${current}${model.slice(legacy.length)}`;
  return [
    `${renamedClause(legacy, current)}; it still works for now — set \`"model": "${renamed}"\` in ${CONFIG_FILENAME}`,
  ];
}

/** Both keys present means the rename was half done: the old entry is ignored, so it goes. */
function providersHelp(providers: Record<string, unknown>): string[] {
  return Object.keys(providers).flatMap((legacy) => {
    const current = RENAMED_PROVIDERS.get(legacy);
    if (current === undefined) return [];
    const edit =
      current in providers
        ? `; \`providers.${current}\` is the one applied — delete \`providers.${legacy}\``
        : `; it still works for now — rename \`providers.${legacy}\` to \`providers.${current}\``;
    return [`${renamedClause(legacy, current)}${edit} in ${CONFIG_FILENAME}`];
  });
}

function renamedClause(legacy: string, current: string): string {
  return `pi-ai renamed provider \`${legacy}\` to \`${current}\``;
}
