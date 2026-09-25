/**
 * The words the CLI teaches its protocol with: the turn rule, the `next:`
 * decision rule every answer ends in, and every line naming a command. Below
 * `commands/` because the commands are not their only reader — `skill.ts`
 * quotes them into SKILL.md and the server answers a refused move with them —
 * and core code importing `commands/` is how the old import cycles formed.
 */
import { openCall } from "./start-call.ts";
import { MAIN_THREAD } from "./threads.ts";
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

/** No --intent: a live session keeps its own, and re-attaching opens no round. */
/** `open` on a live review: no --intent, since re-attaching opens no round. */
export function reattachCall(target: string): string {
  return `lightspeed open ${target}`;
}

export function helpReattach(target: string): string {
  return `Run \`${reattachCall(target)}\` to listen for the reviewer's next Send — ${WAITS_FOR_SEND}`;
}

/**
 * `<id>` where nothing says which: a made-up `t1` is an id the agent would copy
 * into a thread it never saw — or one the reviewer resolved.
 */
export function replyCall(target: string, ids: readonly string[] = ["<id>"]): string {
  const tos = ids.map((id) => `--to ${id} '<answer>'`).join(" ");
  return `lightspeed reply ${tos} ${target}`.trimEnd();
}

export function workCall(target: string): string {
  return `lightspeed work '<plan>' ${target}`.trimEnd();
}

export function publishCall(target: string, id = "<id>"): string {
  return `lightspeed publish ${target} --intent '<what this round changed>' --to ${id} 'done: <what you did>'`;
}

/** Single-quoted for a POSIX shell, where the quote itself is the one character to escape. */
export function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function toPairs(notes: readonly { to: string; text: string }[]): string[] {
  return notes.map((note) => `--to ${note.to} ${shellWord(note.text)}`);
}

/** The reply as typed, so a killed wait is recovered by the command itself: it posts nothing twice. */
export function replyRerun(target: string, notes: readonly { to: string; text: string }[]): string {
  return ["lightspeed reply", ...toPairs(notes), target].join(" ");
}

export function publishRerun(
  target: string,
  intents: readonly string[],
  notes: readonly { to: string; text: string }[],
): string {
  const flags = intents.map((intent) => `--intent ${shellWord(intent)}`);
  return ["lightspeed publish", target, ...flags, ...toPairs(notes)].join(" ");
}

/**
 * Closes every block shown before a wait: the wait may outlive the agent's
 * shell, and the way back must be on screen before it begins, not after.
 */
export function ifKilled(command: string): { next: { if_killed: string } } {
  return {
    next: {
      if_killed: `Killed or timed out before the reviewer's Send? Re-run exactly this — it posts nothing twice: ${command}`,
    },
  };
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
 * The ids a line may name, read off what the session knows: its open ones, at
 * most three, and the main chat when none is open.
 */
export function shownIds(ids: readonly string[]): string[] {
  return ids.length === 0 ? [MAIN_THREAD] : ids.slice(0, 3);
}

/**
 * The decision rule every answer ends in: not a menu of what is legal, but
 * what to do next, keyed by what the agent has decided. Weaker models follow
 * the last lines they read, so those lines carry the protocol. `ids` makes
 * the reply line concrete: the open items the agent is holding right now;
 * `resolved`, the ones the reviewer just closed, whose meaning is spelled out.
 */
export function nextRule(
  turn: TurnLabel,
  target: string,
  ids: readonly string[] = [],
  resolved: readonly string[] = [],
): Record<string, string> {
  if (turn === "agent digesting") return digestingRule(target, ids, resolved);
  if (turn === "agent working") return workingRule(target, shownIds(ids)[0]!);
  if (turn === "ended") {
    return { done: `The review is over. ${helpReopen(target)}` };
  }
  return { listen: `The reviewer holds the turn → ${helpReattach(target)}` };
}

function digestingRule(
  target: string,
  ids: readonly string[],
  resolved: readonly string[],
): Record<string, string> {
  return {
    ...(resolved.length === 0 ? {} : { resolved: resolvedMeaning(resolved) }),
    talk:
      "Anything that needs the reviewer — an answer, a doubt about a change request, a question" +
      ` of your own → one call, every reply in it: ${replyCall(target, shownIds(ids))}`,
    work:
      "Nothing left to discuss and something to change (clear change requests go straight here)" +
      ` → ${workCall(target)}, then edit, test, commit and publish`,
    ambiguity:
      "Anything ambiguous in a change request? Ask now with reply: asking is cheaper than" +
      " redoing a round built on a guess.",
    rule: "You may leave items unanswered. End this turn with reply or with work, never both.",
  };
}

/** Said in the batch itself: the skill is read once, and a resolve read as "dropped" costs a round. */
function resolvedMeaning(resolved: readonly string[]): string {
  return (
    `${resolved.join(", ")}: the reviewer agrees with your last words there — if that was a` +
    " change, implement it (work); it is not withdrawn"
  );
}

function workingRule(target: string, id: string): Record<string, string> {
  return {
    publish: `Edit, test and commit, then → ${publishCall(target, id)} — ${WAITS_FOR_SEND}`,
    stuck:
      "A question for the reviewer? Publish what you have and ask in the new round." +
      " reply works from here only while nothing has changed since work.",
  };
}
