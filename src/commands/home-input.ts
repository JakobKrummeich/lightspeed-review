import { defaultStateDir, loadConfig } from "../config.ts";
import { ReviewError } from "../errors.ts";
import { repoRootOrNone } from "../repo.ts";
import { SessionStore, type SessionRecord } from "../session-store.ts";
import type { HomeInput } from "./home.ts";
import { listening } from "./presence.ts";

/**
 * Nothing here throws, but what stopped a review from running is the answer,
 * not something to swallow: a bare catch once turned a missing config into
 * `sessions: 0`, which was false — the sessions were on disk — and cost a turn.
 */
export async function homeInput(all: boolean): Promise<HomeInput> {
  const repoRoot = repoRootOrNone(process.cwd());
  if (repoRoot === undefined) return { sessions: storedSessions(defaultStateDir()), all };
  try {
    const { stateDir, port } = loadConfig(repoRoot);
    const sessions = storedSessions(stateDir);
    const only = all ? undefined : soleReviewersTurn(sessions, repoRoot);
    const listened = only === undefined ? {} : { listening: await listening(port, only.key) };
    return { repoRoot, sessions, all, ...listened };
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

/** The one case home's answer turns on a live connection: a reviewer's turn someone may be waiting on. */
function soleReviewersTurn(sessions: SessionRecord[], repoRoot: string): SessionRecord | undefined {
  const live = sessions.filter(
    (session) => session.repoRoot === repoRoot && session.status !== "ended",
  );
  const only = live.length === 1 ? live[0] : undefined;
  return only?.turn.holder === "reviewer" ? only : undefined;
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
