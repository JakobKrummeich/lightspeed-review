import { REACHABLE_MODELS } from "./config.ts";
import { DEFAULT_PATH_LIMIT, SELECTION_LIMIT } from "./output.ts";
import { HELP_END, HELP_OPEN, TURN_RULES, WAITS_FOR_SEND, nextRule } from "./turn-help.ts";

export const SKILL_PATH = "skills/lightspeed/SKILL.md";

export const SKILL_AGENTS = ["pi", "claude-code", "codex", "opencode", "vscode"] as const;

export type SkillAgent = (typeof SKILL_AGENTS)[number];

export function isSkillAgent(agent: string): agent is SkillAgent {
  return (SKILL_AGENTS as readonly string[]).includes(agent);
}

// Wrapped for the plain dialect's prose; the frontmatter joins it back onto
// one line, so the two renderings cannot drift apart.
const USE_WHEN =
  "Use when work is ready for review, when a reviewer asked to see changes\n" +
  "in a browser, or when you need targeted feedback on specific lines rather\n" +
  "than a summary.";

const DESCRIPTION = `Get a human review of a branch diff. ${USE_WHEN.replaceAll("\n", " ")}`;

const INTRO = `Semantic diff review: a reviewer reads your branch diff in a browser, comments
on the lines they care about and sends the batch to you. You answer in threads,
change the code, and publish the next round.`;

const DIGESTING = nextRule("agent digesting", "<branch>", ["t4", "t2"]);

const WORKING = nextRule("agent working", "<branch>", ["t4"]);

const THE_TURN = `## The turn

${TURN_RULES.map((rule) => `> ${rule}`).join("\n>\n")}

The review has three live states. The reviewer composes (their turn); you
digest the batch they sent (your turn, short: they are locked out until you
hand back); you work (your turn: they can only queue, and what they queue
goes into your next round).

| command | legal when | waits for the reviewer's Send | turn after |
| --- | --- | --- | --- |
| \`open\` | no review yet, a live one (re-attach), or an ended one with \`--reopen\` | yes | yours, digesting |
| \`reply --to <id> '…'\` | digesting (from working only if nothing changed since \`work\`) | yes | the reviewer's |
| \`work '<plan>'\` | digesting | no | yours, working |
| \`publish --intent '…'\` | working, with new commits | yes | the reviewer's |
| \`end\` | always | no | ended |

\`open\`, \`reply\` and \`publish\` hand the turn back **and** wait for the
next Send, so one call is one turn: ${WAITS_FOR_SEND}. There is no separate
\`wait\` to forget. Plain \`lightspeed\` (no arguments) shows where you are
and the one command to run next.`;

const THE_LOOP = `## The loop

1. **Open the review.**
   > ${HELP_OPEN}

   It extracts \`git diff <base>...<branch>\`, groups the files, opens the
   reviewer's browser, prints the session URL and waits for their first Send.
   \`--intent\` is **required** when opening fresh: you are the only party that
   knows why the branch exists. Omitting it fails with \`intent_missing\`
   before any git or model work.
2. **Digest the batch.** It lists one item per thread (\`t1\`, \`t2\`…): new
   items, replies in threads you answered, and threads the reviewer resolved.
   End the turn with exactly one of:
   - talk — ${DIGESTING.talk}
   - work — ${DIGESTING.work}

   ${DIGESTING.ambiguity} ${DIGESTING.rule}
3. **Work.** Edit, test, commit. ${WORKING.blocked}
4. **Publish.** ${WORKING.publish}
   Files the reviewer already approved come back ticked unless you touched them.
5. **Close it** when the reviewer is done.
   > ${HELP_END}`;

const WHAT_AN_ITEM_SAYS = `## What an item says

\`\`\`
items[2]:
  - id: t4
    status: new
    at: src/turn.ts:20
    selected: "note?: string"
    reviewer: why is note optional here?
  - id: t2
    status: reply
    at: src/poll.ts:40
    you: it retries 3x
    reviewer: and on a 503?
\`\`\`

- \`id\` is what \`--to\` takes; \`main\` is the main chat, where your own
  top-level remarks go.
- \`status\`: \`new\` (a new item), \`reply\` (the reviewer answered in a
  thread; \`you\` is what you said last there), \`resolved\` or
  \`reopened\`. Resolving a question means "no further questions"; resolving
  a change request means "I agree with what you last said" — implement that
  agreed version, it is not withdrawn.
- \`at\` is \`file:line\` (or \`file:start-end\`) in your branch; \`(base)\`
  marks lines numbered in the base. \`selected\` quotes the reviewer's
  selection, cut at ${SELECTION_LIMIT} characters with a pointer to the rest.
  General items have neither.`;

const RULES = `## Rules

- Run \`open\`, \`reply\` and \`publish\` in the foreground, never under a
  timeout. If one is killed anyway, re-run the same command: the server
  recognises it, posts nothing twice and hands you whatever the reviewer sent.
- Every refusal of a move — out of turn, an ended, unknown or ambiguous
  review — names the one right command in its \`help[]\` and exits 2: read
  it rather than retrying. \`turn_not_yours\`: the reviewer holds the turn.
  \`turn_still_yours\`: you are working, so publish. \`nothing_to_publish\`:
  HEAD has not moved since the last round, so commit or reply.
- \`wait\`, \`ask\`, \`say\` and \`start\` were removed in 3.0 and answer
  \`removed_verb\`.
- An ended review answers \`ended: true\`. It is not by itself an approval:
  read \`approval.verdict\` — \`signed-off\` (every file approved),
  \`partial\`, \`none\` or \`empty\`. \`swept\` counts approvals that came out
  of a sweep lane: accepted, never read. \`lightspeed approvals [branch] [base]\`
  names the files (first ${DEFAULT_PATH_LIMIT} per list; \`--full\` for all).
  \`endedBy\` says whether the reviewer or an agent's \`end\` closed it. A
  plain \`open\` on it is refused with \`session_ended\`. Only when the
  reviewer asks for another round:
  \`lightspeed open <branch> [base] --reopen --intent '<why>'\`.
- Every command takes \`<branch> [base]\` explicitly, which is what makes
  concurrent reviews unambiguous. Omit the branch only when the repository has
  exactly one live session. \`base\` defaults to \`main\`.
- State the intent in the reviewer's terms — what the branch is for, not a list
  of the files you touched.`;

const SETUP = `## Setup

The repository needs \`.lightspeed.conf.json\` in its root.
Run \`lightspeed init --config\` to write one:

\`\`\`json
{ "model": "${REACHABLE_MODELS[0]}", "thinking": "off" }
\`\`\`

\`model\` is never defaulted and no command lists the ids. Name one you can
reach:
${REACHABLE_MODELS.map((model) => `- \`${model}\``).join("\n")}

A model nobody has does not fail the run: the round opens with
\`grouping.mode: fallback\`, the whole diff as one group, and a \`fix\` line
naming the key to change.

Optional keys: \`port\` (4388), \`stateDir\` (\`~/.lightspeed\`),
\`feedbackLog\` (\`on\`), \`classify\` — two glob lists,
\`{"mechanical": [], "guardrail": []}\`, naming this repository's bulk files and
the files no verdict may call bulk.

Subscription users run \`lightspeed login <provider>\` (\`anthropic\` ·
\`openai-codex\` · \`github-copilot\`) once per machine — humans only, in
their own terminal; an agent must never run it.`;

const OUTPUT = `## Output

Every command answers TOON on stdout, led by \`round\` and \`turn\` and closed
by \`next:\`: the rule for what to do next, keyed by what you decide. Every failure
answers \`error: {code, message, detail}\` plus \`help[]\` — exit 2 when
re-running the same command cannot help: the command line is wrong, or the move
is wrong for the review's state (out of turn, ended, not found, ambiguous), and
\`help[]\` names the right one. Exit 1 when the machine got in the way — the
server, git, the model, the config — and the same command may work once that is
fixed. Run
\`lightspeed <command> --help\` for a command's flags and two worked examples.`;

const SECTIONS = `${THE_TURN}

${THE_LOOP}

${WHAT_AN_ITEM_SAYS}

${RULES}

${SETUP}

${OUTPUT}`;

/**
 * Generated from the CLI's own `help[]` strings so the guidance an agent
 * installs and the guidance the CLI prints cannot drift. Regenerate with
 * `pnpm run build:skill`; `--check` fails when it is stale.
 */
export function renderSkill(): string {
  return `---
name: lightspeed
description: ${DESCRIPTION}
---

# lightspeed

${INTRO}

${SECTIONS}
`;
}

/**
 * pi and Claude Code read SKILL.md format, so they get exactly `renderSkill()`
 * (also the checked-in artifact, which stays unstamped: the stamp is added by
 * `stampedSkillFor` on the way into an agent's file, so a version bump does not
 * make the artifact stale). Codex, opencode and VS Code read plain
 * markdown: frontmatter goes, and the description's use-when guidance moves
 * into the intro prose so it is not lost with it.
 */
export function renderSkillFor(agent: SkillAgent): string {
  if (agent === "pi" || agent === "claude-code") return renderSkill();
  return `# lightspeed

${INTRO}
${USE_WHEN}

${SECTIONS}
`;
}
