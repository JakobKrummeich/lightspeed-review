import { REACHABLE_MODELS } from "./config.ts";
import { DEFAULT_PATH_LIMIT, PROMPT_LIMIT, SELECTION_LIMIT } from "./output.ts";
import { HELP_END, HELP_START, HELP_WAIT, TURN_RULE } from "./turn-help.ts";

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

const INTRO = `Semantic diff review: a reviewer reads your branch diff in a browser, selects
the lines they care about and sends comments back to you, one round at a time.`;

const THE_TURN = `## The turn

> ${TURN_RULE}

A review has exactly one turn holder. It is the reviewer's until your
\`wait\` is handed their feedback; it is yours from that moment until you
\`ask\`, \`start\` or \`end\`. While you hold it the reviewer's Send only
queues, so a round cannot change under you mid-edit; what they queue meanwhile,
general and line comments alike, goes out in order with their next Send once
the turn is theirs again. Their End is never disabled, so they are never stuck
behind you.

Do not \`wait\` twice on one turn. A \`wait\` that parks gives the turn
back — it says you are listening, not editing — so once you have declared
\`work\`, a second \`wait\` is refused with \`turn_still_yours\` and exit 2
rather than handing the reviewer's Send back while you are still editing. Give the turn up
deliberately instead: \`start <branch> [base] --wait\` to publish what you
changed and block on the next round, or \`ask\` to hand it back with a
question.

Every answer this CLI prints carries \`turn\` and \`round\`. Read \`turn\`
before choosing the next command; the \`help[]\` under it lists the moves that
are legal from where you are. The first answer of each round spells them out;
every answer after it in the same round gives the same list as a one-line
\`Next:\` reminder, because by then you have the long form above in your own
transcript.

| command | turn after | blocks |
| --- | --- | --- |
| \`start\` | reviewer | no, unless \`--wait\` |
| \`wait\` | yours, on delivery | **yes** |
| \`ask\` | reviewer, then yours on their answer | **yes** |
| \`say\` | unchanged | no |
| \`work\` | yours, and the banner names your plan | no |
| \`end\` | ended | no |`;

const THE_LOOP = `## The loop

1. **Show the diff.**
   > ${HELP_START}

   It extracts \`git diff <base>...<branch>\`, groups the files, opens the
   reviewer's browser and prints the session URL.

   \`--intent\` is **required**. You opened the review, so you are the only party
   that knows why the branch exists — the reviewer reads it above the diff and
   the grouping model reads it as the strongest signal it gets. Repeat the flag
   once per reason:

   \`\`\`sh
   lightspeed start feature-auth main \\
     --intent "replace session cookies with signed tokens" \\
     --intent "drop the legacy /login handler"
   \`\`\`

   Omitting it fails with \`intent_missing\` before any git or model work.
2. **Wait for the turn.**
   > ${HELP_WAIT}

   A \`wait\` that is backgrounded or timed out loses the reviewer's feedback.
   It returns when they send, and the turn is yours from that moment.
3. **Say what you are doing, before you go quiet.**
   \`lightspeed work "<plan>" <branch> [base]\` puts your plan in the
   reviewer's banner for as long as the silence lasts. It is not a lock you
   take — you already hold the turn — it is the reason they are waiting.
4. **Address what came back.** Each prompt names the file, the group and the
   exact text the reviewer selected — see **What a prompt says** below for the
   fields that pin it down. Answer a single comment by name, without blocking
   and without giving the turn up:

   \`\`\`sh
   lightspeed say "now one transaction" --for evt_0abc123de_0007
   \`\`\`

   \`--files\` may be added to that line, but only for files a round you have
   already published changed — it is a claim the server checks against the
   between-round diff, not a note. Naming a file you have only just edited is
   refused with \`declaration_invalid\`: say it without \`--files\` now, or
   commit, run \`start\` again and re-send the same line with it.

   If something is unclear, \`lightspeed ask "<question>"\` hands the turn back
   and blocks on the answer — cheaper than guessing and rewriting a round.
5. **Publish the next round.** Fix, commit, then run \`start\` again: it is
   idempotent, re-groups the fresh diff and keeps the conversation. Files the
   reviewer already approved come back ticked and dimmed unless you touched
   them, so each round shows the reviewer only what is new work.
6. **Close it.**
   > ${HELP_END}`;

const WHAT_A_PROMPT_SAYS = `## What a prompt says

An \`annotation\` prompt points at code, a \`message\` prompt is a general
comment. An annotation carries:

\`\`\`json
{
  "type": "annotation",
  "file": "src/server.ts",
  "group": "Ledger write path",
  "side": "new",
  "line_start": 214,
  "line_end": 214,
  "col_start": 12,
  "col_end": 29,
  "selected_text": "throw new Error(…)",
  "comment": "Return a ReviewError instead"
}
\`\`\`

- \`side\` says which version the lines are numbered in: \`new\` is your branch,
  \`old\` is the base. \`line_start\`/\`line_end\` are 1-based and inclusive.
- \`col_start\`/\`col_end\` appear when the reviewer selected part of a line
  rather than whole lines. They are 1-based, inclusive columns into that line as
  the file has it — counted in UTF-16 code units, and the diff's \`+\`/\`-\`
  marker is not one of them. \`col_start\` belongs to \`line_start\`,
  \`col_end\` to \`line_end\`, and an absent one means that line was taken whole.
  Read them as "this is the exact text I mean", not as a range to edit blindly.
- \`selected_text\` quotes exactly those characters. Whole lines keep their
  \`+\`/\`-\` marker; a clipped line is quoted as the file has it.
- The anchor can be missing entirely when the diff printed no line numbers for
  the selection; \`selected_text\` is then all you have.
- A long \`selected_text\` is cut at ${SELECTION_LIMIT} characters and says
  where the rest is — the anchor above points into your own checkout. The
  \`comment\` is never cut. A round that queues more than ${PROMPT_LIMIT}
  prompts reports \`omitted\`; read the rest with \`--full\` before you act.`;

const RULES = `## Rules

- Run \`wait\` and \`ask\` in the foreground, every time. They have no timeout
  by design.
- \`work\` is the only command that requires the turn. Running it without one
  answers \`turn_not_yours\` and exits 2, with the fixing command in its
  \`help[]\` — read it rather than retrying. \`wait\` is the mirror of it:
  run while you hold the turn and are working, it answers
  \`turn_still_yours\` and exits 2 the same way.
- \`Send & End\` from the reviewer ends the review; \`wait\` reports
  \`ended: true\`. \`start\`, \`say\`, \`ask\` and \`work\` on an ended review
  are all refused with \`session_ended\`: there is nobody left to read the
  words, and an ended review holds no turn to declare work on. When
  the reviewer asks for another round — and only then — run
  \`lightspeed start <branch> [base] --reopen --intent "<why>"\`.
- An ended \`wait\` is not by itself an approval. Read \`approval.verdict\`:
  \`signed-off\` (every file approved), \`partial\` (some approved, some not),
  \`none\` (nothing approved) or \`empty\` (the review held no files). Only
  \`signed-off\` is a sign-off; a review may be ended with nothing approved at
  all. The counts \`approved\`, \`unapproved\`, \`swept\` and \`total\` are the
  detail behind that word, and an \`approval\` block absent altogether means the
  server did not report one — never that nothing was approved.
  \`swept\` is the part of \`approved\` that came out of a sweep lane: files the
  review filed as bulk with nothing to decide and approved in one press. Treat
  those as accepted, never as read — \`signed-off\` over a sweep still means
  nobody was asked to read those files, so if something you changed there needs
  a human behind it, say so and ask for that file to be read.
- \`lightspeed approvals [branch] [base]\` names those files — which were
  approved, which were swept, which nobody signed off on. Run it only when
  something turns on which file; the verdict and counts answer most reviews on
  their own. It prints the first ${DEFAULT_PATH_LIMIT} paths of each list, and
  only the lists that name something; the \`counts\` block beside them is read
  off the whole review either way, and \`--full\` prints every path when a list
  was cut. \`endedBy\` is
  \`reviewer\` or \`agent\` — whether a person closed it or an agent's own
  \`lightspeed end\` did — and is absent when the session does not say.
  The \`help[]\` line echoes the verdict and otherwise adds only what those
  fields cannot say: who closed it, and
  whether approvals were swept. It does not repeat the counts — read them.
- Every command takes \`<branch> [base]\` explicitly, which is what makes
  concurrent reviews unambiguous. Omit the branch only when the repository has
  exactly one live session.
- \`base\` defaults to \`main\`.
- State the intent in the reviewer's terms — what the branch is for, not a list
  of the files you touched. They can already see the files.`;

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

Every command answers TOON on stdout, led by \`turn\` and \`round\` and closed
by a \`help[]\` block naming the moves that are legal from there. Every failure
answers \`error: {code, message, detail}\` plus \`help[]\` — exit 2 when the
command line itself is wrong (unknown command, subcommand or flag, a missing or
unparseable argument), exit 1 for everything else. Run
\`lightspeed <command> --help\` for a command's flags and two worked examples.`;

const SECTIONS = `${THE_TURN}

${THE_LOOP}

${WHAT_A_PROMPT_SAYS}

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
 * (also the checked-in artifact). Codex, opencode and VS Code read plain
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
