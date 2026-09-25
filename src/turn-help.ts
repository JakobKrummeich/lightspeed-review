/**
 * The words the CLI teaches its protocol with: the turn rule and every help
 * line naming a move. Below `commands/` because the commands are not their only
 * reader — `skill.ts` quotes them into SKILL.md and the server answers a
 * refused move with them — and core code importing `commands/` is how the old
 * import cycles formed.
 */
import { startCall } from "./start-call.ts";
import type { HelpForm, TurnLabel } from "./turn.ts";

export const HELP_START = `Run \`${startCall("<branch> [base]")}\` to open a review session; repeat --intent once per reason`;

/** The one rule an agent must not get wrong, so it is worded once and repeated
 * verbatim everywhere a blocking command is mentioned. */
export const BLOCKS_IN_FOREGROUND =
  "it blocks until the reviewer sends, so never background it or wrap it in a timeout";

/** Quoted wherever an agent might guess at it instead. */
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

/** `--intent` is required on every round, not only the first: without it the
 * command exits 2 with `intent_missing`, a wasted turn this text caused. */
export function helpNextRound(target: string): string {
  return (
    `Address the feedback, commit, then run \`lightspeed start ${target}` +
    ' --intent "<why this branch exists>"` to show the updated diff —' +
    " --intent is required on every round"
  );
}

/** The move offered to an agent mid-edit, where a bare `wait` is refused: the
 * turn given up deliberately rather than waited for. */
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

type Move = "wait" | "publish" | "ask" | "say" | "work" | "next round" | "reopen";

/**
 * Every `help[]` about the turn is built from this one list — the commands', and
 * the server's when it refuses a move — so nothing can advertise a move the
 * server answers with exit 2: `work` and `say` both once closed with `wait`
 * while the agent held the turn, which the poll refuses. So `wait` is offered
 * on the reviewer's turn and nowhere else; `work` leads on a turn just
 * delivered and is dropped once the agent is working, since redeclaring is a
 * no-op.
 */
function movesFor(turn: TurnLabel): [Move, ...Move[]] {
  if (turn === "ended") return ["reopen"];
  if (turn === "reviewer") return ["wait"];
  if (turn === "agent working") return ["publish", "ask", "say"];
  return ["work", "say", "ask", "next round"];
}

const SPELT: Record<Move, (target: string) => string> = {
  wait: helpWait,
  publish: helpPublishAndWait,
  ask: helpAsk,
  say: helpSay,
  work: helpWork,
  "next round": helpNextRound,
  reopen: helpReopen,
};

/**
 * For a reader already given the moves in full this round: the likeliest next
 * command is written out whole, the rest are the verb and what it takes,
 * because by here the agent has the long form in its own transcript.
 */
const RECALLED: Record<Move, (target: string) => string> = {
  wait: (target) => `\`lightspeed wait ${target}\``,
  publish: (target) => `\`lightspeed start ${target} --wait --intent "<why>"\``,
  ask: () => '`ask "<q>"`',
  say: () => '`say "<text>"`',
  work: (target) => `\`lightspeed work "<plan>" ${target}\``,
  "next round": (target) => `commit then \`start ${target} --intent "<why>"\``,
  reopen: (target) => `the reviewer asks, then \`start ${target} --reopen --intent "<why>"\``,
};

/**
 * It lives here, with the lines it is made of, rather than in `turn.ts`: those
 * lines read `turn.ts` for the label, and a module cannot import its readers.
 */
export function legalMoves(turn: TurnLabel, target: string): [string, ...string[]] {
  const [first, ...rest] = movesFor(turn);
  return [SPELT[first](target), ...rest.map((move) => SPELT[move](target))];
}

export function nextMoves(turn: TurnLabel, target: string): string {
  return `Next: ${movesFor(turn)
    .map((move) => RECALLED[move](target))
    .join(" | ")}`;
}

/**
 * The full block is worth its tokens once per round — it is how an agent learns
 * the protocol from one answer — and after that it is the same bytes again:
 * measured at 146 of an `ask` answer's 187 tokens, with one clause repeated
 * nineteen times in a single transcript. A server too old to have an opinion
 * gets the full block, which is what it always sent.
 */
export function turnHelp(
  turn: TurnLabel,
  target: string,
  form: HelpForm | undefined,
): [string, ...string[]] {
  return form === "short" ? [nextMoves(turn, target)] : legalMoves(turn, target);
}
