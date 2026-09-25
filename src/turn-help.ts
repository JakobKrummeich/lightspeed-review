/**
 * The words the CLI teaches its protocol with: the turn rule, the `next:`
 * decision rule every answer ends in, and every line naming a command. Below
 * `commands/` because the commands are not their only reader — `skill.ts`
 * quotes them into SKILL.md and the server answers a refused move with them —
 * and core code importing `commands/` is how the old import cycles formed.
 */
import { openCall } from "./start-call.ts";
import type { TurnLabel } from "./turn.ts";

/** Placeholders in single quotes: an agent copies these into a shell, where
 * single quotes expand nothing, and TOON prints them without escaping. */
export const HELP_OPEN = `Run \`${openCall("<branch> [base]")}\` to open a review; repeat --intent once per reason`;

/**
 * Worded once and repeated verbatim wherever a command that waits is named.
 * "Waits for your Send" is the CLI's word; the browser's is "locked" — never
 * "blocking", which blurred the two.
 */
export const WAITS_FOR_SEND =
  "it waits for the reviewer's Send, so run it in the foreground and never under a timeout;" +
  " if it is killed anyway, re-run the same command — it posts nothing twice";

/** The three rules the protocol reduces to, quoted wherever an agent might guess. */
export const TURN_RULES = [
  "Discussion strictly alternates: the reviewer sends a batch, you digest it and hand back.",
  "End each turn by talking (reply) or by working (work), never both; ask about anything ambiguous before you work.",
  "Every command that hands the turn back also waits for the next Send, so one call is one turn.",
] as const;

export function helpOpen(target: string): string {
  return `Run \`lightspeed open ${target} --intent '<why this branch exists>'\` to open the review — ${WAITS_FOR_SEND}`;
}

/** No --intent: a live session keeps its own, and re-attaching opens no round. */
export function helpReattach(target: string): string {
  return `Run \`lightspeed open ${target}\` to listen for the reviewer's next Send — ${WAITS_FOR_SEND}`;
}

export function replyCall(target: string, ids: readonly string[] = ["t1"]): string {
  const tos = ids.map((id) => `--to ${id} '<answer>'`).join(" ");
  return `lightspeed reply ${tos} ${target}`.trimEnd();
}

export function workCall(target: string): string {
  return `lightspeed work '<plan>' ${target}`.trimEnd();
}

export function publishCall(target: string, id = "t1"): string {
  return `lightspeed publish ${target} --intent '<what this round changed>' --to ${id} 'done: <what you did>'`;
}

export function endCall(target: string): string {
  return `lightspeed end ${target}`.trimEnd();
}

export function reopenCall(target: string): string {
  return `lightspeed open ${target} --reopen --intent '<why>'`;
}

export const HELP_END = `Run \`${endCall("<branch> [base]")}\` to close the review from your side`;

/** Only ever at the reviewer's request: an ended review is their decision. */
export function helpReopen(target: string): string {
  return `Only if the reviewer asks for another round: \`${reopenCall(target)}\``;
}

/**
 * The decision rule every answer ends in: not a menu of what is legal, but
 * what to do next, keyed by what the agent has decided. Weaker models follow
 * the last lines they read, so those lines carry the protocol. `ids` makes
 * the reply line concrete: the items the agent is holding right now.
 */
export function nextRule(
  turn: TurnLabel,
  target: string,
  ids: readonly string[] = [],
): Record<string, string> {
  if (turn === "agent digesting") return digestingRule(target, ids);
  if (turn === "agent working") return workingRule(target, ids[0]);
  if (turn === "ended") {
    return { done: `The review is over. ${helpReopen(target)}` };
  }
  return { listen: `The reviewer holds the turn → ${helpReattach(target)}` };
}

function digestingRule(target: string, ids: readonly string[]): Record<string, string> {
  const shown = ids.length === 0 ? ["t1"] : ids.slice(0, 3);
  return {
    talk:
      "Anything that needs the reviewer — an answer, a doubt about a change request, a question" +
      ` of your own → one call, every reply in it: ${replyCall(target, shown)}`,
    work:
      "Nothing left to discuss and something to change (clear change requests go straight here)" +
      ` → ${workCall(target)}, then edit, test, commit and publish`,
    ambiguity:
      "Anything ambiguous in a change request? Ask now with reply: asking is cheaper than" +
      " redoing a round built on a guess.",
    rule: "You may leave items unanswered. End this turn with reply or with work, never both.",
  };
}

function workingRule(target: string, id: string | undefined): Record<string, string> {
  return {
    publish: `Edit, test and commit, then → ${publishCall(target, id)} — ${WAITS_FOR_SEND}`,
    blocked:
      "Stuck on a question for the reviewer? Publish what you have and ask in the new round." +
      " reply works from here only while nothing has changed since work.",
  };
}
