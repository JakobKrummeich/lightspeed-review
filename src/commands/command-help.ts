import { LOGIN_PROVIDERS } from "../llm/pi-auth.ts";
import { destinationHelp, INIT_SCOPES } from "../skill-install.ts";
import { SKILL_AGENTS } from "../skill.ts";
import { DEFAULT_PATH_LIMIT, renderToon, type StructuredOutput } from "../output.ts";
import { BLOCKS_IN_FOREGROUND, TURN_RULE } from "../turn-help.ts";
import { HELP_RESTART_AGENT } from "./init.ts";

const SESSION_ARGUMENTS = {
  "[branch]": "branch under review; omit it when the repo has one live session",
  "[base]": "base branch, defaults to main",
};

/** Per-command `--help`, kept next to the commands so a new flag and its docs are
 * one edit apart. Rendered as TOON: agents read help the same way they read results. */
const COMMAND_HELP: Record<string, StructuredOutput> = {
  start: {
    command: "start",
    description: "Extract the branch diff, group it and open the review page",
    arguments: { "<branch>": "branch under review", "[base]": "base branch, defaults to main" },
    flags: {
      '--intent "<why>"':
        "required, repeatable: why this branch exists, shown above the diff and" +
        " given to the grouping model",
      "--no-open": "create the session without opening a browser",
      "--reopen": "open a new round on a review the reviewer ended, once they ask for one",
      "--wait": "block on the round you just published instead of returning at once",
      "--base <ref>": "base branch, when it is not given positionally",
      "--model <name>": "grouping model for this run, overriding .lightspeed.conf.json",
    },
    examples: [
      'lightspeed start feature-auth main --intent "replace session cookies with signed tokens"',
      'lightspeed start feature-auth --intent "issue #412: log out every device on password change" --intent "drop the legacy /login handler"',
    ],
  },
  wait: {
    command: "wait",
    description:
      `Block until the reviewer sends, and take the turn when they do.` +
      ` Run it in the foreground: ${BLOCKS_IN_FOREGROUND}`,
    arguments: SESSION_ARGUMENTS,
    flags: {
      "--full": "print reviewer selections in full instead of truncating them",
    },
    turn:
      `reviewer while it blocks, yours on delivery. Run it while you hold the turn and` +
      ` are working and it is refused with \`turn_still_yours\` and exit 2 — publish the` +
      ` round or \`ask\` instead, which give the turn up deliberately. ${TURN_RULE}`,
    examples: ["lightspeed wait feature-auth main", "lightspeed wait feature-auth main --full"],
  },
  ask: {
    command: "ask",
    description:
      "Put a question to the reviewer and block on their answer. The question is drawn" +
      " as a card with its own answer box, so answering it costs the reviewer one press" +
      ` and leaves whatever they have queued queued. ${BLOCKS_IN_FOREGROUND}`,
    arguments: { "<question>": "what to ask, first and in quotes", ...SESSION_ARGUMENTS },
    turn: "back to the reviewer, then yours again when they answer",
    examples: [
      'lightspeed ask "should the retry be per-request or per-batch?" feature-auth main',
      'lightspeed ask "you said drop the legacy handler — including its tests?"',
    ],
  },
  say: {
    command: "say",
    description:
      "Say something without blocking and without giving the turn up. `--for` pins the" +
      " whole answer under the comment it answers, where the reviewer is already looking",
    arguments: { "<text>": "what to say, first and in quotes", ...SESSION_ARGUMENTS },
    flags: {
      "--for <id>": "the comment this answers, by the id `wait` printed with it",
      "--files <a,b>":
        "comma-separated paths that comment led to changes in; needs --for, and names" +
        " only files a round you have already published changed — commit and re-run" +
        " `start` before claiming one",
    },
    turn: "unchanged: speaking is free, and an agent mid-edit is still mid-edit",
    examples: [
      'lightspeed say "good catch — all three are one transaction now" feature-auth main',
      'lightspeed say "one transaction now, in the round I just published" --for evt_0abc123de_0008 --files src/db/index.ts',
    ],
  },
  work: {
    command: "work",
    description:
      "Declare the silence you are about to keep. The reviewer's banner names the plan" +
      " instead of saying you have their feedback, until you speak again",
    arguments: { "<plan>": "what you are about to do, first and in quotes", ...SESSION_ARGUMENTS },
    turn:
      "yours already — `work` says what you are doing with it, it does not take it." +
      " Running it without the turn is `turn_not_yours` and exit 2",
    examples: [
      'lightspeed work "wrapping the three writes in one transaction" feature-auth main',
      'lightspeed work "splitting the helper out, then re-running the suite"',
    ],
  },
  approvals: {
    command: "approvals",
    description:
      "Name the files behind the counts `wait` reports: approved, swept, unapproved." +
      " Run it when something turns on which file, not by default",
    arguments: SESSION_ARGUMENTS,
    flags: {
      "--full":
        `print every path instead of the first ${DEFAULT_PATH_LIMIT} of each list;` +
        " the counts beside them are the whole review either way",
    },
    examples: ["lightspeed approvals feature-auth main"],
  },
  end: {
    command: "end",
    description: "Close a review session from the agent side",
    arguments: SESSION_ARGUMENTS,
    turn: "ended. Never gated: ending is the one move both sides can always make",
    examples: ["lightspeed end feature-auth main", "lightspeed end"],
  },
  serve: {
    command: "serve",
    description:
      "Run the review server in the foreground until it is stopped." +
      " `start` spawns this in the background, so it is only needed for debugging",
    examples: ["lightspeed serve"],
  },
  // One entry covers the whole `feedback` family: help resolves by command name,
  // so `feedback list --help` lands here too and must document every subcommand.
  feedback: {
    command: "feedback",
    description:
      "Read the durable feedback ledger. Bare, it summarises every recorded review" +
      " comment across repositories; the subcommands read, inspect and prune it",
    subcommands: {
      "feedback list": "filtered items, oldest first, capped and without patches by default",
      "feedback show <id>": "one item with its patch, context and outcome in full",
      "feedback prune --before <date>":
        "delete records older than a date, atomically; reports every month it touches",
    },
    flags: {
      "--repo <path>": "only this repository; `.` means the one you are in (list, prune)",
      "--since <date|30d>": "only items at or after an ISO date or a duration back (list)",
      "--cursor <id>": "resume strictly after an item id (list)",
      "--limit <n>": "at most n items; toon defaults to 20, jsonl and md to no cap (list)",
      "--verdict <name>": "addressed | ignored | repeated | unknown (list)",
      "--file <path>": "exact path or directory prefix, e.g. src/ledger (list)",
      "--format <name>": "toon (default), jsonl or md; jsonl and md print raw text",
      "--with-patches": "include the round patch and the code context of each item (list)",
      "--max-bytes <n>":
        "drop whole items past this budget and report the cursor; toon defaults to 50000 (list)",
      "--before <date|30d>": "prune cutoff; required, there is no default (prune)",
      "--dry-run": "print what a prune would delete and change nothing (prune)",
    },
    examples: [
      "lightspeed feedback",
      "lightspeed feedback list --repo . --since 30d --format jsonl",
      "lightspeed feedback list --verdict repeated --with-patches --max-bytes 200000",
      "lightspeed feedback show evt_01JQ8Z5K3M_7f2a",
      "lightspeed feedback prune --before 2025-12-01 --repo .",
    ],
  },
  stop: {
    command: "stop",
    description: "Shut the background review server down; sessions stay on disk",
    examples: ["lightspeed stop"],
  },
  login: {
    command: "login",
    description:
      "Sign in to a subscription provider with its own OAuth flow. Human-run, once per" +
      " machine: it opens a browser and asks questions, so an agent must never run it",
    arguments: { "<provider>": `one of ${LOGIN_PROVIDERS.join(", ")}` },
    examples: ["lightspeed login anthropic"],
  },
  init: {
    command: "init",
    description:
      "Write the integration instructions into the file one coding agent reads." +
      ` ${HELP_RESTART_AGENT}`,
    flags: {
      "--agent <id>": `one of ${SKILL_AGENTS.join(", ")}; required unless --config is on its own`,
      "--scope <where>": `${INIT_SCOPES.join(" | ")}; global by default, and only where the skill goes`,
      "--config":
        "write a starter .lightspeed.conf.json in this directory, never over one that" +
        " exists; valid on its own, without an agent",
      "--dry-run": "report what would be written and change nothing",
    },
    // Generated from the table `init` writes by, so a path documented here is
    // the path the command uses.
    destinations: destinationHelp(),
    behaviour:
      "Safe to re-run: a whole-file target is rewritten only when it differs, and a" +
      " shared AGENTS.md keeps its own content with lightspeed's block replaced in place." +
      " The skill is stamped with this CLI's version, so any later lightspeed command" +
      " refreshes it after an upgrade unless it was edited by hand",
    examples: [
      "lightspeed init --agent pi",
      "lightspeed init --config",
      "lightspeed init --agent claude-code --scope project",
      "lightspeed init --agent codex --scope project --config",
      "lightspeed init --agent vscode --scope project --dry-run",
    ],
  },
  skill: {
    command: "skill",
    description:
      "Print the integration instructions for one coding agent as raw markdown —" +
      " redirect stdout into the file that agent reads. `lightspeed init` does the" +
      " redirecting for you; this is the escape hatch for a path of your own. codex," +
      " opencode and vscode get it between lightspeed:start/end markers, so a copy" +
      " appended to a shared file is refreshed like the block `init` writes",
    flags: {
      "--agent <id>": `one of ${SKILL_AGENTS.join(", ")}; defaults to pi`,
    },
    destinations: destinationHelp(),
    examples: [
      "lightspeed init --agent claude-code --scope project",
      "mkdir -p .claude/skills/lightspeed && lightspeed skill --agent claude-code > .claude/skills/lightspeed/SKILL.md",
      "lightspeed skill --agent codex >> AGENTS.md",
      "mkdir -p .github && lightspeed skill --agent vscode > .github/copilot-instructions.md",
    ],
  },
  logout: {
    command: "logout",
    description:
      "Remove lightspeed's own stored credential for a provider;" +
      " the pi agent's file is never touched",
    arguments: { "<provider>": "the provider id to sign out of" },
    examples: ["lightspeed logout anthropic"],
  },
};

/** `notice` rides along after the page, so a stale skill is reported on the
 * help an agent reads most. */
export function commandHelp(command: string, notice: StructuredOutput = {}): string | undefined {
  const help = COMMAND_HELP[command];
  return help === undefined ? undefined : `${renderToon({ ...help, ...notice })}\n`;
}

/**
 * Taken from the help the command prints itself so the two can never drift. A
 * command nobody wrote help for is still listed: pointing at its own `--help`
 * beats hiding it or rendering `undefined`.
 */
export function commandSummary(command: string): string {
  const description = COMMAND_HELP[command]?.description;
  return typeof description === "string" ? description : `Run \`lightspeed ${command} --help\``;
}
