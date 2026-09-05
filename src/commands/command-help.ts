import { LOGIN_PROVIDERS } from "../llm/pi-auth.ts";
import { DEFAULT_PATH_LIMIT } from "./approvals.ts";
import { destinationHelp, INIT_SCOPES } from "../skill-install.ts";
import { SKILL_AGENTS } from "../skill.ts";
import { renderToon, type StructuredOutput } from "../output.ts";
import { HELP_RESTART_AGENT } from "./init.ts";
import { BLOCKS_IN_FOREGROUND } from "./home.ts";

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
      "--base <ref>": "base branch, when it is not given positionally",
      "--model <name>": "grouping model for this run, overriding .lightspeed.conf.json",
    },
    examples: [
      'lightspeed start feature-auth main --intent "replace session cookies with signed tokens"',
      'lightspeed start feature-auth --intent "issue #412: log out every device on password change" --intent "drop the legacy /login handler"',
    ],
  },
  poll: {
    command: "poll",
    description: `Wait for reviewer feedback. Run it in the foreground: ${BLOCKS_IN_FOREGROUND}`,
    arguments: {
      "[branch]": "branch under review; omit it when the repo has one live session",
      "[base]": "base branch, defaults to main",
    },
    flags: {
      '--agent-reply "<summary>"': "answer the reviewer before waiting again",
      "--for <id>":
        "repeatable, with --agent-reply: declare what one comment led to," +
        " by the id poll printed with it; --note and --files after it describe it",
      '--note "<answer>"': "the answer to the comment of the --for before it",
      "--files <a,b>": "comma-separated paths that comment changed, for the --for before it",
      "--full": "print reviewer selections in full instead of truncating them",
    },
    examples: [
      "lightspeed poll feature-auth main",
      'lightspeed poll feature-auth main --agent-reply "wrapped it in a transaction"',
      'lightspeed poll feature-auth main --agent-reply "addressed all three"' +
        ' --for evt_0abc123de_0007 --note "now one transaction" --files src/api/users.ts' +
        ' --for evt_0abc123de_0008 --note "intentional: the index covers it"',
    ],
  },
  approvals: {
    command: "approvals",
    description:
      "Name the files behind poll's counts: approved, swept, unapproved." +
      " Run it when something turns on which file, not by default",
    arguments: {
      "[branch]": "branch under review; omit it when the repo has one live session",
      "[base]": "base branch, defaults to main",
    },
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
    arguments: {
      "[branch]": "branch under review; omit it when the repo has one live session",
      "[base]": "base branch, defaults to main",
    },
    examples: ["lightspeed end feature-auth main"],
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
      " shared AGENTS.md keeps its own content with lightspeed's block replaced in place",
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
      " redirecting for you; this is the escape hatch for a path of your own",
    flags: {
      "--agent <id>": `one of ${SKILL_AGENTS.join(", ")}; defaults to pi`,
    },
    // The same table `init` writes by: pi scans `~/.pi/agent/skills`, and the
    // `~/.pi/skills` this once named is a directory pi never looks in.
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

export function commandHelp(command: string): string | undefined {
  const help = COMMAND_HELP[command];
  return help === undefined ? undefined : `${renderToon(help)}\n`;
}

/**
 * The line top-level help gives a command, taken from the help it prints itself
 * so the two can never drift. A command nobody wrote help for is still listed —
 * pointing at its own `--help` beats hiding it or rendering `undefined`.
 */
export function commandSummary(command: string): string {
  const description = COMMAND_HELP[command]?.description;
  return typeof description === "string" ? description : `Run \`lightspeed ${command} --help\``;
}
