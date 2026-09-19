import type { StructuredOutput } from "../output.ts";
import type { SessionRecord } from "../session-store.ts";
import { roundNumber, turnLabel, type TurnLabel } from "../turn.ts";

/** One row of the home view session table. */
export interface SessionSummary {
  branch: string;
  base: string;
  status: string;
  /**
   * Whose move it is, so the home view answers "may I send?" and "am I owed a
   * turn?" without a second command. `pending` beside it is what the reviewer
   * queued and no `wait` has taken yet.
   */
  turn: TurnLabel;
  round: number;
  pending: number;
}

/** `--intent` is required, so the canonical help line carries it: only the agent
 * opening the review knows why the branch exists. */
export const HELP_START =
  'Run `lightspeed start <branch> [base] --intent "<why this branch exists>"`' +
  " to open a review session; repeat --intent once per reason";

/** The one rule an agent must not get wrong, so it is worded once and repeated
 * verbatim everywhere a blocking command is mentioned. */
export const BLOCKS_IN_FOREGROUND =
  "it blocks until the reviewer sends, so never background it or wrap it in a timeout";

/**
 * The rule the whole protocol reduces to, quoted wherever an agent might guess
 * at it instead.
 */
export const TURN_RULE = "Queue always. End always. Send only on your turn.";

export function helpWait(target: string): string {
  return (
    `Run \`lightspeed wait ${target}\` in the foreground to take the turn when the reviewer sends` +
    ` — ${BLOCKS_IN_FOREGROUND}`
  );
}

export const HELP_WAIT = helpWait("<branch> [base]");

export function helpAsk(target: string): string {
  return (
    `Run \`lightspeed ask "<question>" ${target}\` to put a question to the reviewer and wait for` +
    ` the answer — ${BLOCKS_IN_FOREGROUND}`
  );
}

export function helpSay(target: string): string {
  return (
    `Run \`lightspeed say "<text>" ${target}\` to answer without blocking;` +
    " add `--for <id>` to pin the answer under the comment it answers"
  );
}

export function helpWork(target: string): string {
  return (
    `Run \`lightspeed work "<plan>" ${target}\` before you start editing:` +
    " the reviewer's banner names the plan for as long as you are quiet"
  );
}

/** `--intent` is required on every round, not only the first, so the line that
 * sends an agent back to `start` carries it: without it the command it just read
 * exits 2 with `intent_missing`, which is a wasted turn this text caused. */
export function helpNextRound(target: string): string {
  return (
    `Address the feedback, commit, then run \`lightspeed start ${target}` +
    ' --intent "<why this branch exists>"` to show the updated diff —' +
    " --intent is required on every round"
  );
}

/** The same move made by an agent that is going to block on what it publishes:
 * one command, and the turn given up deliberately rather than waited for. It is
 * the move offered to an agent mid-edit, where a bare `wait` is refused. */
export function helpPublishAndWait(target: string): string {
  return (
    `Run \`lightspeed start ${target} --wait --intent "<why this branch exists>"\`` +
    " to publish what you changed and block on the next round"
  );
}

export function helpEnd(target: string): string {
  return `Run \`lightspeed end ${target}\` to close the session`;
}

export const HELP_END = helpEnd("<branch> [base]");

/** A review that ended stays ended — an agent must not reopen one uninvited —
 * so every command that meets an ended session says so the same way. */
export function helpReopen(target: string): string {
  return (
    `Run \`lightspeed start ${target} --reopen --intent "<why>"\`` +
    " once the reviewer asks for one"
  );
}

/**
 * The moves that are legal from a turn, in the order they are usually wanted.
 * Every `help[]` about the turn is built from this one list — the commands', and
 * the server's when it refuses a move — so nothing can advertise a move the
 * server answers with exit 2. That is not hypothetical: `work` and `say` both
 * closed with `wait` while the agent held the turn, which the poll refuses.
 *
 * `wait` is therefore offered on the reviewer's turn and nowhere else. An agent
 * that holds it is handed the moves that give it up deliberately instead —
 * publish the round, or ask — and `work` is offered only before the silence is
 * declared, because redeclaring it is a no-op an agent should not be sent to.
 *
 * It lives here, with the lines it is made of, rather than in `turn.ts`: those
 * lines read `turn.ts` for the label, and a module cannot import its readers.
 */
export function legalMoves(turn: TurnLabel, target: string): [string, ...string[]] {
  if (turn === "ended") return [helpReopen(target)];
  if (turn === "reviewer") return [helpWait(target)];
  if (turn === "agent working") {
    return [helpPublishAndWait(target), helpAsk(target), helpSay(target)];
  }
  return [helpAsk(target), helpSay(target), helpWork(target), helpNextRound(target)];
}

/** Stored sessions as home-view rows. Ended ones are history, not work. */
export function sessionSummaries(sessions: SessionRecord[]): SessionSummary[] {
  return sessions
    .filter((session) => session.status !== "ended")
    .map((session) => ({
      branch: session.branch,
      base: session.base,
      status: session.status,
      turn: turnLabel(session),
      round: roundNumber(session),
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
    help: [TURN_RULE, HELP_START, HELP_WAIT, HELP_END],
  };
}
