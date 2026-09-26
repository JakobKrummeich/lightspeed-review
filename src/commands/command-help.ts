import { LOGIN_PROVIDERS } from "../llm/pi-auth.ts";
import { destinationHelp, INIT_SCOPES } from "../skill-install.ts";
import { SKILL_AGENTS } from "../skill.ts";
import { DEFAULT_PATH_LIMIT, renderToon, type StructuredOutput } from "../output.ts";
import { TURN_RULES, WAITS_FOR_SEND } from "../turn-help.ts";
import { HELP_RESTART_AGENT } from "./init.ts";

const SESSION_ARGUMENTS = {
  "[branch]": "branch under review; omit it when the repo has one live session",
  "[base]": "base branch, defaults to main",
};

/** Per-command `--help`, kept next to the commands so a new flag and its docs are
 * one edit apart. Rendered as TOON: agents read help the same way they read results. */
const COMMAND_HELP: Record<string, StructuredOutput> = {
  open: {
    command: "open",
    description:
      "Open the review — extract the branch diff, group it, open the reviewer's page —" +
      ` and wait for their first Send. On a live review it re-attaches instead, with no` +
      ` new round — ${WAITS_FOR_SEND}`,
    arguments: {
      "<branch>": "branch under review; omit it to re-attach to the repo's one live review",
      "[base]": "base branch, defaults to main",
    },
    flags: {
      "--intent '<why>'":
        "required when opening fresh, repeatable: why this branch exists, shown above the" +
        " diff and given to the grouping model",
      "--no-open": "create the session without opening a browser",
      "--reopen": "open a new round on a review the reviewer ended, once they ask for one",
      "--base <ref>": "base branch, when it is not given positionally",
      "--model <name>": "grouping model for this run, overriding .lightspeed.conf.json",
    },
    turn: `the reviewer's until their Send is delivered, then yours (digesting). ${TURN_RULES[0]}`,
    examples: [
      "lightspeed open feature-auth main --intent 'replace session cookies with signed tokens'",
      "lightspeed open feature-auth",
    ],
  },
  reply: {
    command: "reply",
    description:
      "Every answer of your turn in one call, each under the item it concerns: answers," +
      " doubts about a change request, your own questions. Hands the turn back and waits" +
      ` for the next Send — ${WAITS_FOR_SEND}`,
    arguments: SESSION_ARGUMENTS,
    flags: {
      "--to <id> '<text>'":
        "required, repeatable: the item id from the batch (`t4`), or `main` for the main" +
        " chat, and what you say there",
    },
    turn:
      "legal while you digest; from working only if nothing changed since `work`" +
      " (otherwise publish). The reviewer's afterwards",
    examples: [
      "lightspeed reply --to t4 'it retries 3x, then gives up' --to t5 'doubt: that breaks X — sure?'",
      "lightspeed reply --to main 'all clear, nothing to change' feature-auth main",
    ],
  },
  work: {
    command: "work",
    description:
      "End the discussion and start changing code. The reviewer's header names the plan" +
      " and they can only queue until you publish. Waits for nothing",
    arguments: { "<plan>": "what you are about to do, first and in quotes", ...SESSION_ARGUMENTS },
    turn: `yours (digesting) before, yours (working) after. ${TURN_RULES[1]}`,
    examples: [
      "lightspeed work 'wrap the three writes in one transaction' feature-auth main",
      "lightspeed work 'rename busy → working, return ReviewError'",
    ],
  },
  publish: {
    command: "publish",
    description:
      "End a working turn: your new commits become the next round, `--to` notes land in" +
      " the threads they addressed, and the reviewer's queue drops into the round" +
      ` — ${WAITS_FOR_SEND}`,
    arguments: SESSION_ARGUMENTS,
    flags: {
      "--intent '<what>'": "required, repeatable: what this round changed",
      "--to <id> '<text>'": "optional, repeatable: a 'done: …' note under the item it addressed",
      "--model <name>": "grouping model for this run, overriding .lightspeed.conf.json",
    },
    turn: "working before, the reviewer's after. Refused while HEAD has not moved since the last round",
    examples: [
      "lightspeed publish feature-auth --intent 'return ReviewError' --to t5 'done: returns ReviewError'",
      "lightspeed publish --intent 'split the helper out'",
    ],
  },
  approvals: {
    command: "approvals",
    description:
      "Name the files behind the counts an ended review reports: approved, swept, unapproved." +
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
      " `open` spawns this in the background, so it is only needed for debugging",
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
      " refreshes a machine-wide one after an upgrade unless it was edited by hand;" +
      " a project one is reported as skill_stale instead, so your repo is never" +
      " changed behind your back",
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
