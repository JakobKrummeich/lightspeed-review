import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "./paths.ts";
import type { SkillAgent } from "./skill.ts";

/** Whose skill directory is written: the machine's, or the repository the
 * command was run in. Global is the default because an agent is installed once
 * per machine and then used on every checkout. */
export const INIT_SCOPES = ["global", "project"] as const;

export type InitScope = (typeof INIT_SCOPES)[number];

/**
 * `file` means the agent reads a file of its own, so lightspeed owns it whole.
 * `block` means the agent reads one instructions file shared with everything
 * else the user tells it, so lightspeed owns a marked region and nothing else.
 */
export type WriteMode = "file" | "block";

export type WriteStatus = "written" | "updated" | "unchanged";

export interface SkillTarget {
  path: string;
  mode: WriteMode;
}

export interface InstallReport {
  path: string;
  status: WriteStatus;
  mode: WriteMode;
}

/** Where the command is standing. Both are parameters, never read from the
 * process, so a test drives temporary directories instead of a real machine. */
export interface InitRoots {
  home: string;
  cwd: string;
}

interface Destination {
  /** Absent when the agent has no machine-wide instructions file at all. */
  global?: string;
  project: string;
  mode: WriteMode;
}

/**
 * Where each harness actually reads its skill, which is not where the setup
 * instructions used to say: pi scans `~/.pi/agent/skills`, and `~/.pi/skills`
 * — the path the README named for years — is a directory pi never looks in.
 * Checked against pi's own `docs/skills.md` before it was written down again.
 */
const DESTINATIONS: Record<SkillAgent, Destination> = {
  pi: {
    global: "~/.pi/agent/skills/lightspeed/SKILL.md",
    project: ".pi/skills/lightspeed/SKILL.md",
    mode: "file",
  },
  "claude-code": {
    global: "~/.claude/skills/lightspeed/SKILL.md",
    project: ".claude/skills/lightspeed/SKILL.md",
    mode: "file",
  },
  codex: { global: "~/.codex/AGENTS.md", project: "AGENTS.md", mode: "block" },
  opencode: { global: "~/.config/opencode/AGENTS.md", project: "AGENTS.md", mode: "block" },
  // Copilot reads its instructions per repository; there is no global file to write.
  vscode: { project: ".github/copilot-instructions.md", mode: "block" },
};

/** Undefined means this agent has no file at that scope, which is a sentence
 * only the command can say — the error text belongs next to the command. */
export function skillTarget(
  agent: SkillAgent,
  scope: InitScope,
  roots: InitRoots,
): SkillTarget | undefined {
  const destination = DESTINATIONS[agent];
  if (scope === "project") {
    return { path: join(roots.cwd, destination.project), mode: destination.mode };
  }
  if (destination.global === undefined) return undefined;
  return { path: expandHome(destination.global, roots.home), mode: destination.mode };
}

/** The same table as `--help` prose, so the path the help documents and the
 * path the command writes cannot drift apart. Worded without flag names because
 * both `init` and `skill` show it, and only one of them has a `--scope`. */
export function destinationHelp(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DESTINATIONS).map(([agent, destination]) => [agent, describe(destination)]),
  );
}

function describe(destination: Destination): string {
  if (destination.global === undefined) {
    return `${destination.project} in the repo; it has no machine-wide file`;
  }
  return `${destination.global} for the machine, or ${destination.project} in the repo`;
}

/** Markers, not a heading: a heading is prose a user may rewrite, and these have
 * to survive being edited around for the next run to find its own block. */
const BLOCK_START = "<!-- lightspeed:start -->";
const BLOCK_END = "<!-- lightspeed:end -->";

/**
 * Installs the rendered skill and says what that changed. Content is compared
 * before anything is written: agents re-run `init` after every upgrade, and a
 * rewrite that changes nothing still shows up as a dirty file in a repository.
 */
export function installSkill(
  target: SkillTarget,
  rendered: string,
  dryRun: boolean,
): InstallReport {
  const existing = readIfAny(target.path);
  const desired = target.mode === "file" ? rendered : merged(existing, block(rendered));
  return {
    path: target.path,
    status: writeChange(target.path, existing, desired, dryRun),
    mode: target.mode,
  };
}

function block(rendered: string): string {
  return `${BLOCK_START}\n${rendered.trimEnd()}\n${BLOCK_END}`;
}

/**
 * A re-run refreshes the region between the markers and leaves every other line
 * where the user put it. A file with no markers keeps everything it said and
 * gains the block at the end — appending twice is the failure this replaces.
 */
function merged(existing: string | undefined, marked: string): string {
  if (existing === undefined) return `${marked}\n`;
  const bounds = blockBounds(existing);
  if (bounds === undefined) return `${existing.trimEnd()}\n\n${marked}\n`;
  return `${existing.slice(0, bounds.start)}${marked}${existing.slice(bounds.end)}`;
}

/** Where a previous run's block sits, when this file carries one. */
function blockBounds(existing: string): { start: number; end: number } | undefined {
  const start = existing.indexOf(BLOCK_START);
  const end = existing.indexOf(BLOCK_END, start);
  if (start === -1 || end === -1) return undefined;
  return { start, end: end + BLOCK_END.length };
}

function writeChange(
  path: string,
  existing: string | undefined,
  desired: string,
  dryRun: boolean,
): WriteStatus {
  if (existing === desired) return "unchanged";
  // A dry run still reports the status it would have reached, so the two runs
  // read the same and the caller can trust the plan it was shown.
  if (!dryRun) writeThrough(path, desired);
  return existing === undefined ? "written" : "updated";
}

/** Every destination sits under a directory the user may never have created —
 * a fresh machine has no `~/.pi/agent/skills` until something makes one. */
function writeThrough(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Absent and unreadable are the same answer here: either way there is nothing
 * to compare against, and an unwritable path fails at the write with its own errno. */
function readIfAny(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
