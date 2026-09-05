import { ReviewError } from "./errors.ts";
import type { SessionRecord } from "./session-store.ts";

export interface ResolvedSession {
  branch: string;
  base: string;
}

const NAME_THE_BRANCH = "Run the command as `lightspeed <command> <branch> [base]`";

/**
 * Which review a command applies to. Explicit arguments always win — that is
 * what makes concurrent sessions unambiguous — and omitting the branch is a
 * shortcut that only works when exactly one live session belongs to this repo.
 */
export function resolveSession(
  sessions: SessionRecord[],
  repoRoot: string,
  branch: string | undefined,
  base: string | undefined,
): ResolvedSession {
  if (branch !== undefined) return { branch, base: base ?? "main" };
  const candidates = sessions.filter(
    (session) => session.repoRoot === repoRoot && session.status !== "ended",
  );
  const only = candidates[0];
  if (candidates.length === 1 && only) return { branch: only.branch, base: only.base };
  if (candidates.length === 0) {
    throw new ReviewError({
      code: "ambiguous_session",
      message: `no live review session for ${repoRoot}`,
      suggestions: [NAME_THE_BRANCH, "Run `lightspeed start <branch> [base]` to open one"],
    });
  }
  throw new ReviewError({
    code: "ambiguous_session",
    message: `${candidates.length} live review sessions for ${repoRoot}`,
    detail: candidates.map((session) => `${session.branch} ${session.base}`).join(", "),
    suggestions: [NAME_THE_BRANCH],
  });
}
