import { DEFAULT_PATH_LIMIT } from "./commands/approvals.ts";
import { HELP_END, HELP_POLL, HELP_START } from "./commands/home.ts";

/** Where the generated skill lives, relative to the repository root. */
export const SKILL_PATH = "skills/lightspeed/SKILL.md";

/** Every agent `lightspeed skill --agent <id>` can address. */
export const SKILL_AGENTS = ["pi", "claude-code", "codex", "opencode", "vscode"] as const;

export type SkillAgent = (typeof SKILL_AGENTS)[number];

/** Narrows a command line's `--agent` value; every caller of `renderSkillFor`
 * and of the destination table has to pass this gate first. */
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
2. **Wait for feedback.**
   > ${HELP_POLL}

   A poll that is backgrounded or timed out loses the reviewer's feedback.
3. **Address what came back.** Each prompt names the file, the group and the
   exact text the reviewer selected — see **What a prompt says** below for the
   fields that pin it down. Fix, commit, then run \`start\` again:
   it is idempotent, re-groups the fresh diff and keeps the conversation.
   Files the reviewer already approved come back ticked and dimmed unless you
   touched them, so each round shows the reviewer only what is new work.
4. **Keep the reviewer in the loop.** Reply while you work with
   \`lightspeed poll <branch> [base] --agent-reply "<summary>"\`.
5. **Close it.**
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
  the selection; \`selected_text\` is then all you have.`;

const RULES = `## Rules

- Run \`poll\` in the foreground, every time. It has no timeout by design.
- \`Send & End\` from the reviewer ends the review; poll reports \`ended: true\`.
  \`start\` on an ended review is refused with \`session_ended\`. When the reviewer
  asks for another round — and only then — run
  \`lightspeed start <branch> [base] --reopen\`.
- An ended poll is not by itself an approval. Read \`approval.verdict\`:
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
  their own. It prints the first ${DEFAULT_PATH_LIMIT} paths of each list; the
  \`count\` block beside them is read off the whole review either way, and
  \`--full\` prints every path when a list was cut. \`endedBy\` is
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

The repository needs \`.lightspeed.conf.json\` in its root:

\`\`\`json
{ "model": "<provider/model>", "thinking": "off" }
\`\`\`

Optional keys: \`port\` (4388), \`stateDir\` (\`~/.lightspeed\`),
\`feedbackLog\` (\`on\`), \`classify\` — two glob lists,
\`{"mechanical": [], "guardrail": []}\`, naming this repository's bulk files and
the files no verdict may call bulk.

Subscription users run \`lightspeed login <provider>\` (\`anthropic\` ·
\`openai-codex\` · \`github-copilot\`) once per machine — humans only, in
their own terminal; an agent must never run it.`;

const OUTPUT = `## Output

Every command answers TOON on stdout with a \`help[]\` block of next steps, and
every failure answers \`error: {code, message, detail}\` plus \`help[]\` — exit 2
when the command line itself is wrong (unknown command, subcommand or flag, a
missing or unparseable argument), exit 1 for everything else. Run
\`lightspeed <command> --help\` for a command's flags.`;

const SECTIONS = `${THE_LOOP}

${WHAT_A_PROMPT_SAYS}

${RULES}

${SETUP}

${OUTPUT}`;

/**
 * The installable skill, generated from the CLI's own `help[]` strings so the
 * guidance an agent installs and the guidance the CLI prints cannot drift.
 * Regenerate with `pnpm run build:skill`; `--check` fails when it is stale.
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
 * One body, two wrappers. pi and Claude Code read SKILL.md format, so they get
 * exactly `renderSkill()` (also the checked-in artifact). Codex, opencode and
 * VS Code read plain markdown: frontmatter goes, and the description's use-when
 * guidance moves into the intro prose so it is not lost with it.
 */
export function renderSkillFor(agent: SkillAgent): string {
  if (agent === "pi" || agent === "claude-code") return renderSkill();
  return `# lightspeed

${INTRO}
${USE_WHEN}

${SECTIONS}
`;
}
