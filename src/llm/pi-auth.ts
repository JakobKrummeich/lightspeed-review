import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * The credential file the pi agent writes on `pi auth login`. Its shape is one
 * type-tagged credential per provider id, which is exactly pi-ai's `Credential`.
 */
export function piAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

/**
 * Reads the pi agent's own credentials, so a machine that runs pi can review
 * without exporting anything. Env vars still work for providers the file lacks.
 * A real store, not a one-shot read: OAuth tokens are refreshed and written
 * back. Every failure is silence — missing/malformed file means "no credential",
 * which the caller already reports as `pi_auth_missing` with the fix.
 */
export function piAuthStore(path = piAuthPath()): CredentialStore {
  let writes: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = writes.then(task, task);
    writes = next.catch(() => undefined);
    return next;
  };

  return {
    async read(providerId) {
      return (await readAll(path))[providerId];
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const all = await readAll(path);
      return Object.entries(all).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    modify(providerId, fn) {
      return enqueue(async () => {
        const all = await readAll(path);
        const next = await fn(all[providerId]);
        if (next === undefined) return all[providerId];
        await writeAll(path, { ...all, [providerId]: next });
        return next;
      });
    },
    delete(providerId) {
      return enqueue(async () => {
        const all = await readAll(path);
        if (!(providerId in all)) return;
        delete all[providerId];
        await writeAll(path, all);
      });
    },
  };
}

/**
 * The providers `lightspeed login` can sign in to: the subscription OAuth
 * flows pi-ai ships. An allowlist, not a probe of pi-ai's registry, so the
 * error for anything else can say exactly what is on offer.
 */
export const LOGIN_PROVIDERS = ["anthropic", "openai-codex", "github-copilot"] as const;

/** Lightspeed's own credential file, beside the sessions in the state dir. */
export function lightspeedAuthPath(stateDir: string): string {
  return join(stateDir, "auth.json");
}

/**
 * The credentials `lightspeed login` writes: same shape and store body as pi's,
 * in lightspeed's own state dir — a login must never edit pi's file, where a
 * mistake would log the human out of another tool.
 */
export function lightspeedAuthStore(stateDir: string): CredentialStore {
  return piAuthStore(lightspeedAuthPath(stateDir));
}

/**
 * Lightspeed's credentials over pi's. `read`/`list` prefer the primary; `modify`
 * routes to the store already holding the credential, so an OAuth refresh lands
 * in the file that owns the token — refreshing pi's token into lightspeed's file
 * would leave pi a rotated-away refresh token; fresh logins land in the primary.
 * `delete` touches only the primary: logout must not sign the human out of pi.
 * Ownership is a read before the write — a cross-store race needs two concurrent
 * logins to one provider from one CLI, not worth locking for.
 */
export function layeredCredentialStore(
  primary: CredentialStore,
  fallback: CredentialStore,
): CredentialStore {
  return {
    async read(providerId) {
      return (await primary.read(providerId)) ?? (await fallback.read(providerId));
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const [own, inherited] = await Promise.all([primary.list(), fallback.list()]);
      const owned = new Set(own.map((info) => info.providerId));
      return [...own, ...inherited.filter((info) => !owned.has(info.providerId))];
    },
    async modify(providerId, fn) {
      const owner = (await primary.read(providerId)) !== undefined ? primary : fallback;
      const holder = (await owner.read(providerId)) !== undefined ? owner : primary;
      return holder.modify(providerId, fn);
    },
    delete(providerId) {
      return primary.delete(providerId);
    },
  };
}

async function readAll(path: string): Promise<Record<string, Credential>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, Credential>;
  } catch {
    return {};
  }
}

/**
 * Temp-write-then-rename so an interrupted refresh cannot truncate credentials.
 * Mode 600: a rotated token must not become world-readable via a review tool.
 * Directory made first — this may be the first touch of a fresh state dir.
 */
async function writeAll(path: string, all: Record<string, Credential>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.auth.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
