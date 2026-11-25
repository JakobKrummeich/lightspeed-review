import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEndArgs } from "../src/commands/end.ts";
import { parseOpenArgs } from "../src/commands/open.ts";
import { parsePublishArgs } from "../src/commands/publish.ts";
import { parseReplyArgs } from "../src/commands/reply.ts";
import { parseWorkArgs } from "../src/commands/work.ts";
import { openCall } from "../src/open-call.ts";
import {
  HELP_OPEN,
  TURN_RULES,
  WAITS_FOR_SEND,
  endedClause,
  endedMessage,
  helpReopen,
  groupingNotice,
  ifKilled,
  openRerun,
  nextRule,
  endCall,
  publishCall,
  publishLine,
  reattachCall,
  reopenCall,
  replyCall,
  replyRerun,
  workCall,
} from "../src/turn-help.ts";

const TARGET = "feat/tokens main";

/** D5: not a menu of what is legal, but what to do next, keyed by the decision. */
test("digesting: the rule is talk or work, never both, with ambiguity asked first", () => {
  const rule = nextRule("agent digesting", TARGET, ["t1", "t4"]);

  assert.deepEqual(Object.keys(rule), ["talk", "work", "ambiguity", "rule"]);
  assert.match(
    rule.talk,
    /lightspeed reply --to t1 '<answer>' --to t4 '<answer>' feat\/tokens main/,
  );
  assert.match(rule.work, /lightspeed work '<plan>' feat\/tokens main/);
  assert.match(rule.work, /clear change requests go straight here/);
  assert.match(rule.rule, /never both/);
});

test("the reply line names at most three items, and the main chat when none is open", () => {
  const many = nextRule("agent digesting", TARGET, ["t1", "t2", "t3", "t4"]);
  assert.doesNotMatch(many.talk, /t4/);
  assert.match(nextRule("agent digesting", TARGET).talk, /--to main '<answer>'/);
  assert.doesNotMatch(nextRule("agent digesting", TARGET).talk, /t1/);
});

test("a line with no session to read names a placeholder id, never a made-up one", () => {
  assert.match(replyCall(TARGET), /--to <id> '<answer>'/);
  assert.match(publishCall(TARGET), /--to <id> 'done: /);
});

test("resolved items get their meaning spelled out: nothing more wanted, last words only a note", () => {
  const rule = nextRule(
    "agent digesting",
    TARGET,
    ["t2"],
    [
      { id: "t1", worded: true },
      { id: "t3", worded: false },
      { id: "t5", worded: true },
    ],
  );

  assert.equal(
    rule.resolved,
    "t1, t3, t5: the reviewer needs nothing more there — no change, no answer." +
      " t1, t5: the last word is a closing note, not a request",
  );
  const bare = nextRule("agent digesting", TARGET, [], [{ id: "t3", worded: false }]);
  assert.equal(bare.resolved, "t3: the reviewer needs nothing more there — no change, no answer");
  assert.deepEqual(Object.keys(nextRule("agent digesting", TARGET, ["t2"])), [
    "talk",
    "work",
    "ambiguity",
    "rule",
  ]);
});

test("working: publish, waiting with no timeout; a question goes in the new round", () => {
  const rule = nextRule("agent working", TARGET, ["t5"]);

  assert.deepEqual(Object.keys(rule), ["publish", "stuck"]);
  assert.match(rule.publish, /lightspeed publish feat\/tokens main --intent .* --to t5 'done: /);
  assert.ok(rule.publish.endsWith(WAITS_FOR_SEND));
  assert.match(rule.stuck, /while nothing has changed since work/);
  assert.match(nextRule("agent working", TARGET).publish, /--to main 'done: /);
});

test("the reviewer's turn: the only move is to listen by re-running open", () => {
  const rule = nextRule("reviewer", TARGET);

  assert.deepEqual(Object.keys(rule), ["listen"]);
  assert.match(rule.listen!, /lightspeed open feat\/tokens main`/);
  assert.match(rule.listen!, /NO timeout parameter/);
});

test("ended: done, and a new round only when the reviewer asks for one", () => {
  const rule = nextRule("ended", TARGET);

  assert.deepEqual(Object.keys(rule), ["done"]);
  assert.equal(rule.done, `The review is over. ${helpReopen(TARGET)}`);
  assert.match(rule.done!, /lightspeed open feat\/tokens main --reopen --intent '<why>'/);
});

/** Single quotes: an agent pastes these into a shell, where they expand nothing. */
test("every placeholder is single-quoted, so a pasted line runs as written", () => {
  for (const line of [HELP_OPEN, replyCall(TARGET), workCall(TARGET), publishCall(TARGET)]) {
    assert.doesNotMatch(line, /"</, line);
  }
  assert.match(HELP_OPEN, /--intent '<why this branch exists>'/);
});

test("the turn rules are the three the protocol reduces to", () => {
  assert.equal(TURN_RULES.length, 3);
  assert.match(TURN_RULES[1], /reply.*work.*never both/);
});

/** One wording for who closed a review, wherever an ended review is explained. */
test("the closer is named the same way in every ended-review sentence", () => {
  for (const endedBy of ["reviewer", "agent", undefined] as const) {
    assert.ok(endedMessage(endedBy).startsWith(endedClause(endedBy)), String(endedBy));
  }
  assert.equal(endedClause("agent"), "`lightspeed end` ended this review, not the reviewer");
  assert.equal(endedClause("reviewer"), "the reviewer ended this review");
  assert.equal(endedClause(undefined), "this review is ended");
});

/**
 * Weaker models ran a waiting command under their shell tool's timeout, read
 * the kill as the review dying, and opened a second review while the
 * reviewer's Send sat in the first. Every clause below answers one of those
 * misreadings.
 */
test("a waiting command is described by how long it takes and what a kill leaves alive", () => {
  assert.match(
    WAITS_FOR_SEND,
    /does not return until the reviewer Sends \(often minutes to hours\)/,
  );
  assert.match(
    WAITS_FOR_SEND,
    /call your shell tool with NO timeout parameter, not via `timeout` or `&`/,
  );
  assert.match(WAITS_FOR_SEND, /only the command died/);
  assert.match(WAITS_FOR_SEND, /the server and this review stay live and hold the reviewer's Send/);
  assert.match(WAITS_FOR_SEND, /re-run exactly the same command with NO timeout/);
  assert.match(WAITS_FOR_SEND, /posts nothing twice/);
  assert.match(WAITS_FOR_SEND, /never open another review, end or reopen to recover/);
  assert.doesNotMatch(WAITS_FOR_SEND, /foreground/);
});

test("the kill recovery says the review survived, forbids a second review, and ends on the command", () => {
  const line = ifKilled("reviewer", "lightspeed open feat main").next!.if_killed;

  assert.match(line, /^Killed or timed out\? Only this command died/);
  assert.match(line, /the server and this review stay live and hold the reviewer's Send/);
  assert.match(line, /never open another review, end or reopen to recover/);
  assert.match(line, /Re-run exactly this, with NO timeout parameter — it posts nothing twice/);
  assert.ok(line.endsWith(": lightspeed open feat main"), line);
});

test("a hand-back of a batch being digested has no wait to recover, so no kill line", () => {
  assert.deepEqual(ifKilled("agent digesting", "lightspeed open feat main"), {});
});

test("the grouping notice counts the files and closes on the command that recovers it", () => {
  const notice = groupingNotice(12, "lightspeed open feat main --intent 'why'");

  assert.deepEqual(Object.keys(notice), ["status", "next"]);
  assert.equal(notice.status, "grouping 12 files — can take minutes");
  assert.ok(notice.next.if_killed.endsWith(": lightspeed open feat main --intent 'why'"));
});

test("a fresh open's re-run repeats every intent and the switches, and gives up on an apostrophe", () => {
  assert.equal(
    openRerun("feat main", ["a", "b"], { open: false, reopen: true }),
    "lightspeed open feat main --intent 'a' --intent 'b' --no-open --reopen",
  );
  assert.equal(openRerun("feat main", ["a"], {}), "lightspeed open feat main --intent 'a'");
  assert.equal(openRerun("feat main", ["it's"], {}), undefined);
});

/**
 * The argv a shell hands the CLI for a pasted line: a single-quoted text is one
 * word. Single quotes only, because that is all these lines print
 * (`pastesAsPrinted`).
 */
function argvOf(line: string): { verb: string | undefined; args: string[] } {
  const words = [...line.matchAll(/'([^']*)'|(\S+)/g)].map(([, quoted, bare]) => quoted ?? bare!);
  assert.equal(words[0], "lightspeed", line);
  return { verb: words[1], args: words.slice(2) };
}

const PARSERS: Record<string, (args: string[]) => { branch?: string; base?: string }> = {
  open: parseOpenArgs,
  reply: parseReplyArgs,
  work: parseWorkArgs,
  publish: parsePublishArgs,
  end: parseEndArgs,
};

/**
 * These lines are built here and read by the verbs' own parsers in
 * `commands/`, and nothing else ties the two: a flag renamed on one side would
 * still print, and the agent who pasted it would get `unknown_flag` — or a
 * command aimed at another review.
 */
const HELP_LINES = [
  openCall(TARGET),
  reattachCall(TARGET),
  reopenCall(TARGET),
  replyCall(TARGET),
  replyCall(TARGET, ["t1", "t4"]),
  workCall(TARGET),
  publishCall(TARGET),
  endCall(TARGET),
];

test("every command a help line prints is one its verb reads, aimed at the same review", () => {
  for (const line of HELP_LINES) {
    const { verb, args } = argvOf(line);
    const parse = PARSERS[verb ?? ""];
    assert.ok(parse !== undefined, `${line}: no parser for ${verb}`);

    const { branch, base } = parse(args);
    assert.deepEqual({ branch, base }, { branch: "feat/tokens", base: "main" }, line);
  }
});

/**
 * "Re-run exactly this — it posts nothing twice" holds only if the line reads
 * back as the same words: the server knows a re-run by its verb and words
 * (`fingerprintOf`), so a line that parsed to anything else would be a second
 * post of the reply the reviewer already has.
 */
test("a kill recovery reads back through its verb's parser as the call that printed it", () => {
  const notes = [
    { to: "t1", text: "it is one already" },
    { to: "main", text: "-1 on that,  spaced" },
  ];
  const intents = ["sign the tokens", "drop the legacy /login handler"];
  const session = { branch: "feat/tokens", base: "main" };

  assert.deepEqual(parseReplyArgs(argvOf(replyRerun(TARGET, notes)).args), { notes, ...session });
  assert.deepEqual(parsePublishArgs(argvOf(publishLine(TARGET, intents, notes)!).args), {
    ...session,
    model: undefined,
    intents,
    notes,
  });
  for (const switches of [{}, { open: false, reopen: true }]) {
    assert.deepEqual(parseOpenArgs(argvOf(openRerun(TARGET, intents, switches)!).args), {
      ...session,
      open: true,
      reopen: false,
      ...switches,
      model: undefined,
      intents,
    });
  }
});
