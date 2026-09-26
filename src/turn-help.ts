/**
 * The words the CLI teaches its protocol with: the turn rule, the `next:`
 * decision rule every answer ends in, and every line naming a command. Below
 * `commands/` because the commands are not their only reader — `skill.ts`
 * quotes them into SKILL.md and the server answers a refused move with them —
 * and core code importing `commands/` is how the old import cycles formed.
 */
import { openCall } from "./open-call.ts";
import type { ReviewCloser } from "./session-types.ts";
import { MAIN_THREAD, type Resolved } from "./threads.ts";
import type { TurnLabel } from "./turn.ts";

/** Placeholders in single quotes: an agent copies these into a shell, where
 * single quotes expand nothing, and TOON prints them without escaping. */
export const HELP_OPEN = `Run \`${openCall("<branch> [base]")}\` to open a review; repeat --intent once per reason`;

/**
 * The words every kill recovery shares. Weaker models ran the waits under
 * their shell tool's own timeout, read the kill as the server or the review
 * dying, and opened a second review while the reviewer's Send sat in the
 * first — so the tool parameter is named, the survivors are named, and the
 * wrong recoveries are forbidden by name. "Foreground" said none of that.
 */
const NO_TIMEOUT = "call your shell tool with NO timeout parameter, not via `timeout` or `&`";
const NEVER_RESTART = "never open another review, end or reopen to recover";
const RERUN_THIS = "Re-run exactly this, with NO timeout parameter — it posts nothing twice";

/**
 * Worded once and repeated verbatim wherever a command that waits is named.
 * "Waits for your Send" is the CLI's word; the browser's is "locked" — never
 * "blocking", which blurred the two.
 */
export const WAITS_FOR_SEND =
  `it does not return until the reviewer Sends (often minutes to hours), so ${NO_TIMEOUT};` +
  " if it is killed anyway, only the command died — the server and this review stay live and" +
  " hold the reviewer's Send: re-run exactly the same command with NO timeout (it posts" +
  ` nothing twice), and ${NEVER_RESTART}`;

/**
 * What the wait after a hand-back does, said before it starts: a batch the agent
 * already holds comes straight back, and anything else waits for a Send.
 */
export function waitClause(turn: TurnLabel | undefined): string {
  return turn === "agent digesting"
    ? "handing back the batch you are digesting"
    : "waiting for the reviewer's Send";
}

/** The three rules the protocol reduces to, quoted wherever an agent might guess. */
export const TURN_RULES = [
  "Discussion strictly alternates: the reviewer sends a batch, you digest it and hand back.",
  "End each turn by talking (reply) or by working (work), never both; ask about anything ambiguous before you work.",
  "Every command that hands the turn back also waits for the next Send, so one call is one turn.",
] as const;

/** `open` on a live review: no --intent — a live session keeps its own, and re-attaching opens no round. */
export function reattachCall(target: string): string {
  return `lightspeed open ${target}`;
}

/**
 * The server is gone but the review is not: `open` on it starts the server and
 * re-attaches. Never the fresh-open line — its `--intent` reads as "open a new
 * review", and one the reviewer ended stays ended.
 */
export function helpRestart(target: string): string {
  return `Run \`${reattachCall(target)}\` to restart the review server and re-attach — ${WAITS_FOR_SEND}`;
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

/**
 * Whether a word survives the trip as printed: single-quoted, and inside a TOON
 * string that escapes `"`, `\` and line breaks. An apostrophe cannot be
 * shell-quoted without a `"` or a `\`, and a word holding any escaped character
 * is printed escaped — so a line with one pastes into a shell as something else.
 */
function pastesAsPrinted(text: string): boolean {
  return !/['"\\\n\r\t]/.test(text);
}

function toPairs(notes: readonly { to: string; text: string }[]): string[] {
  return notes.map((note) => `--to ${note.to} '${note.text}'`);
}

/**
 * The command that recovers a wait killed after its words landed. The command
 * as typed, which the server answers as a re-run and posts nothing twice — or,
 * when some word cannot be printed so it pastes as shown, re-attaching, which
 * waits for the same Send and quotes nothing.
 */
export function replyRerun(target: string, notes: readonly { to: string; text: string }[]): string {
  if (!notes.every((note) => pastesAsPrinted(note.text))) return reattachCall(target);
  return ["lightspeed reply", ...toPairs(notes), target].join(" ");
}

export function publishRerun(
  target: string,
  intents: readonly string[],
  notes: readonly { to: string; text: string }[],
): string {
  return publishLine(target, intents, notes) ?? reattachCall(target);
}

/** The publish as typed, or `undefined` when a word would not paste as printed. */
export function publishLine(
  target: string,
  intents: readonly string[],
  notes: readonly { to: string; text: string }[],
): string | undefined {
  const words = [...intents, ...notes.map((note) => note.text)];
  if (!words.every(pastesAsPrinted)) return undefined;
  return ["lightspeed publish", target, ...intentFlags(intents), ...toPairs(notes)].join(" ");
}

function intentFlags(intents: readonly string[]): string[] {
  return intents.map((intent) => `--intent '${intent}'`);
}

/**
 * A fresh `open` as typed, for a kill before its round exists: nothing is on
 * the server yet, so the re-attach line would fail on its missing --intent,
 * and one without `--reopen` would be refused as ended. `undefined` when an
 * intent would not paste as printed — there is no re-attach to fall back on.
 */
export function openRerun(
  target: string,
  intents: readonly string[],
  switches: { open?: boolean; reopen?: boolean },
): string | undefined {
  if (!intents.every(pastesAsPrinted)) return undefined;
  const flags = [
    ...intentFlags(intents),
    ...(switches.open === false ? ["--no-open"] : []),
    ...(switches.reopen === true ? ["--reopen"] : []),
  ];
  return ["lightspeed open", target, ...flags].join(" ");
}

/**
 * Printed before the model call, which can take minutes and is the step a
 * short shell timeout lands in: a command killed there had printed nothing,
 * so the agent had no recovery line and read the silence as a dead review.
 * No bound on the call itself — any number would be arbitrary for a diff
 * whose size nobody knows in advance.
 */
export function groupingNotice(
  files: number,
  command: string | undefined,
): { status: string; next: { if_killed: string } } {
  const rerun =
    command === undefined
      ? "Re-run the same command, unchanged, with NO timeout parameter — it posts nothing twice"
      : `${RERUN_THIS}: ${command}`;
  return {
    status: `grouping ${files} files — can take minutes`,
    next: {
      if_killed: `Killed or timed out? Only this command died, and the review is unharmed; ${NEVER_RESTART}. ${rerun}`,
    },
  };
}

/**
 * Closes every block shown before a wait: the wait may outlive the agent's
 * shell, and the way back must be on screen before it begins, not after. None
 * while the agent digests: the "wait" then hands the held batch straight back
 * (as `waitClause` says), and a recovery line there read as a wait to come.
 */
export function ifKilled(
  turn: TurnLabel | undefined,
  command: string,
): { next?: { if_killed: string } } {
  if (turn === "agent digesting") return {};
  return {
    next: {
      if_killed:
        "Killed or timed out? Only this command died — the server and this review stay live" +
        ` and hold the reviewer's Send; ${NEVER_RESTART}. ${RERUN_THIS}: ${command}`,
    },
  };
}

/**
 * Every block shown before a wait ends on the review's address, at the top
 * level: the agent relays what it read last, and an address nested in
 * `session:` — or absent, on `reply` — was relayed stale or not at all, leaving
 * the reviewer hunting for the tab the agent is waiting on.
 */
export function urlLast<T extends object>(block: T, url: string): T & { url: string } {
  return { ...block, url };
}

export function endCall(target: string): string {
  return `lightspeed end ${target}`.trimEnd();
}

export function reopenCall(target: string): string {
  return `lightspeed open ${target} --reopen --intent '<why>'`;
}

export const HELP_END = `Run \`${endCall("<branch> [base]")}\` to close the review from your side`;

/**
 * An ended review still answers what it ended on: the ticks are on disk, read
 * without a server, and they are the verdict the agent's refused command never
 * got to hear.
 */
export function helpEndedOn(target: string): string {
  return `Run \`lightspeed approvals ${target}\` for the verdict the review ended on`;
}

/**
 * Who closed an ended review, worded once for every sentence that explains
 * one — a refusal, the batch that reports the end, the home of a repo whose
 * latest review is over. Blamed on the reviewer, an agent's own `lightspeed end`
 * reached its user as the reviewer's decision; "you ended" was a guess too,
 * since another shell or the human may have run it. Unnamed only on a record
 * older than `endedBy`.
 */
export function endedClause(endedBy: ReviewCloser | undefined): string {
  if (endedBy === "reviewer") return "the reviewer ended this review";
  if (endedBy === "agent") return "`lightspeed end` ended this review, not the reviewer";
  return "this review is ended";
}

/** The refusal an ended review answers every move with: a new round is the reviewer's call either way. */
export function endedMessage(endedBy: ReviewCloser | undefined): string {
  if (endedBy === "reviewer") return `${endedClause(endedBy)}; only they ask for a new round`;
  if (endedBy === "agent")
    return `${endedClause(endedBy)}; a new round is still the reviewer's call`;
  return `${endedClause(endedBy)}; only the reviewer asks for a new round`;
}

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
  resolved: readonly Resolved[] = [],
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
  resolved: readonly Resolved[],
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

/**
 * Said in the batch itself: the skill is read once, and a resolve read as
 * "dropped" costs a round. Two readings, because a resolve that carries words
 * is those words' deadline, not agreement with whatever the agent said last —
 * which may have been a question.
 */
function resolvedMeaning(resolved: readonly Resolved[]): string {
  const ids = (worded: boolean) =>
    resolved.filter((one) => one.worded === worded).map((one) => one.id);
  const said = ids(true);
  const bare = ids(false);
  return [
    ...(said.length === 0
      ? []
      : [`${said.join(", ")}: resolved with a last word — do what it says`]),
    ...(bare.length === 0
      ? []
      : [
          `${bare.join(", ")}: the reviewer accepts your last answer there — if it promised a` +
            " change, make it (work); it is not withdrawn",
        ]),
  ].join(". ");
}

function workingRule(target: string, id: string): Record<string, string> {
  return {
    publish: `Edit, test and commit, then → ${publishCall(target, id)} — ${WAITS_FOR_SEND}`,
    stuck:
      "A question for the reviewer? Publish what you have and ask in the new round." +
      " reply works from here only while nothing has changed since work.",
  };
}
