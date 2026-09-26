import { defaultStateDir, loadConfig, type LightspeedConfig } from "../config.ts";
import { ReviewError } from "../errors.ts";
import { repoRootOrNone } from "../repo.ts";
import { SessionStore, type SessionRecord } from "../session-store.ts";
import type { HomeInput } from "./home.ts";
import { listening } from "./presence.ts";
import { assertServerSharesState } from "./server-lifecycle.ts";

/**
 * Nothing here throws but a server keeping its reviews in another state dir,
 * and what stopped a review from running is the answer, not something to
 * swallow: a bare catch once turned a missing config into `sessions: 0`, which
 * was false — the sessions were on disk — and cost a turn. The server is asked
 * for the same reason: "no active review sessions" read off files it does not
 * read sent an agent to open a second review beside the live one.
 */
export async function homeInput(all: boolean): Promise<HomeInput> {
  const repoRoot = repoRootOrNone(process.cwd());
  if (repoRoot === undefined) return { sessions: storedSessions(defaultStateDir()), all };
  const config = configOf(repoRoot);
  if (config === "missing" || config === "invalid") {
    // The store is a machine-wide directory a config only redirects, so an
    // unreadable one still knows where to look: the default.
    return { repoRoot, config, sessions: storedSessions(defaultStateDir()), all };
  }
  await assertServerSharesState(config.port, config.stateDir);
  const sessions = storedSessions(config.stateDir);
  const only = all ? undefined : soleReviewersTurn(sessions, repoRoot);
  const listened = only === undefined ? {} : { listening: await listening(config.port, only.key) };
  return { repoRoot, sessions, all, ...listened };
}

function configOf(repoRoot: string): LightspeedConfig | "missing" | "invalid" {
  try {
    return loadConfig(repoRoot);
  } catch (error) {
    return codeOf(error) === "config_missing" ? "missing" : "invalid";
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
