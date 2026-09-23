import { defaultStateDir, loadConfig } from "../config.ts";
import { ReviewError } from "../errors.ts";
import { repoRootOrNone } from "../repo.ts";
import { SessionStore, type SessionRecord } from "../session-store.ts";
import type { HomeInput } from "./home.ts";

/**
 * Nothing here throws, but what stopped a review from running is the answer,
 * not something to swallow: a bare catch once turned a missing config into
 * `sessions: 0`, which was false — the sessions were on disk — and cost a turn.
 */
export function homeInput(all: boolean): HomeInput {
  const repoRoot = repoRootOrNone(process.cwd());
  if (repoRoot === undefined) return { sessions: storedSessions(defaultStateDir()), all };
  try {
    const { stateDir } = loadConfig(repoRoot);
    return { repoRoot, sessions: storedSessions(stateDir), all };
  } catch (error) {
    // The store is a machine-wide directory a config only redirects, so an
    // unreadable one still knows where to look: the default.
    return {
      repoRoot,
      config: codeOf(error) === "config_missing" ? "missing" : "invalid",
      sessions: storedSessions(defaultStateDir()),
      all,
    };
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof ReviewError ? error.code : undefined;
}

/** A corrupt session file must not take the whole view down with it. */
function storedSessions(stateDir: string): SessionRecord[] {
  try {
    return new SessionStore(stateDir).list();
  } catch {
    return [];
  }
}
