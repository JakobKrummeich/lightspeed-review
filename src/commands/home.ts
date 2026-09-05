import type { StructuredOutput } from "../output.ts";
import type { SessionRecord } from "../session-store.ts";

/** One row of the home view session table. */
export interface SessionSummary {
  branch: string;
  base: string;
  status: string;
  pending: number;
}

/** `--intent` is required, so the canonical help line carries it: only the agent
 * opening the review knows why the branch exists. */
export const HELP_START =
  'Run `lightspeed start <branch> [base] --intent "<why this branch exists>"`' +
  " to open a review session; repeat --intent once per reason";

/** The one rule an agent must not get wrong, so it is worded once and repeated
 * verbatim everywhere `poll` is mentioned. */
export const BLOCKS_IN_FOREGROUND =
  "it blocks until the reviewer sends, so never background it or wrap it in a timeout";

export function helpPoll(target: string): string {
  return (
    `Run \`lightspeed poll ${target}\` in the foreground to wait for reviewer feedback` +
    ` — ${BLOCKS_IN_FOREGROUND}`
  );
}

export const HELP_POLL = helpPoll("<branch> [base]");

export const HELP_END = "Run `lightspeed end <branch> [base]` to close a session";

/** A review that ended stays ended — an agent must not reopen one uninvited —
 * so every command that meets an ended session says so the same way. */
export function helpReopen(target: string): string {
  return (
    "Only the reviewer reopens a review: run" +
    ` \`lightspeed start ${target} --reopen\` when they ask for a new round`
  );
}

/** Stored sessions as home-view rows. Ended ones are history, not work. */
export function sessionSummaries(sessions: SessionRecord[]): SessionSummary[] {
  return sessions
    .filter((session) => session.status !== "ended")
    .map((session) => ({
      branch: session.branch,
      base: session.base,
      status: session.status,
      pending: session.pending.length,
    }));
}

/** Content-first: the session table is the content, `help[]` the disclosure.
 * Empty means a definitive `sessions: 0` + message, never an omitted key. */
export function homeOutput(sessions: SessionSummary[]): StructuredOutput {
  if (sessions.length === 0) {
    return {
      sessions: 0,
      message: "no active review sessions",
      help: [HELP_START],
    };
  }
  return {
    sessions,
    help: [HELP_START, HELP_POLL, HELP_END],
  };
}
