import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expandHome } from "./paths.ts";
import { SKILL_AGENTS, type SkillAgent } from "./skill.ts";

/** Global is the default because an agent is installed once per machine and
 * then used on every checkout. */
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

/** Parameters, never read from the process, so a test drives temporary
 * directories instead of a real machine. */
export interface InitRoots {
  home: string;
  cwd: string;
}

interface Destination {
  global?: string;
  project: string;
  mode: WriteMode;
}

/**
 * pi scans `~/.pi/agent/skills`; `~/.pi/skills` — the path the README named
 * for years — is a directory pi never looks in (checked against pi's own
 * `docs/skills.md`).
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

export interface KnownTarget {
  agent: SkillAgent;
  scope: InitScope;
  target: SkillTarget;
}

/**
 * Every file `init` could have written for this home and this directory, each
 * once: codex and opencode share `AGENTS.md` in a repository, and one file is
 * one thing to check and at most one thing to report.
 */
export function knownSkillTargets(roots: InitRoots): KnownTarget[] {
  const known = new Map<string, KnownTarget>();
  for (const scope of INIT_SCOPES) {
    for (const agent of SKILL_AGENTS) {
      const target = skillTarget(agent, scope, roots);
      if (target !== undefined && !known.has(target.path)) {
        known.set(target.path, { agent, scope, target });
      }
    }
  }
  return [...known.values()];
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
 * Content is compared before anything is written: agents re-run `init` after
 * every upgrade, and a rewrite that changes nothing still shows up as a dirty
 * file in a repository.
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

export interface SkillText {
  owned: string | undefined;
  rest: string;
}

/**
 * What lightspeed owns in a target — the whole file, or only what sits between
 * its markers — and the rest, which is the user's. The rest is returned too: a
 * skill pasted in without markers is one lightspeed cannot rewrite, since its
 * extent is unknown, but its stamp still says whose it is.
 */
export function readSkillText(target: SkillTarget): SkillText {
  if (target.mode === "file") return { owned: readIfAny(target.path), rest: "" };
  const existing = readIfAny(target.path) ?? "";
  const bounds = blockBounds(existing);
  if (bounds === undefined) return { owned: undefined, rest: existing };
  return {
    owned: existing.slice(bounds.start + BLOCK_START.length, bounds.end - BLOCK_END.length),
    rest: `${existing.slice(0, bounds.start)}${existing.slice(bounds.end)}`,
  };
}

/**
 * What `skill` prints. A shared-file agent's copy comes between the markers, so
 * one appended by hand is a block a later CLI finds and refreshes like `init`'s.
 */
export function printedSkill(agent: SkillAgent, rendered: string): string {
  return DESTINATIONS[agent].mode === "file" ? rendered : block(rendered);
}

function block(rendered: string): string {
  return `${BLOCK_START}\n${rendered.trimEnd()}\n${BLOCK_END}`;
}

/**
 * A file with no markers keeps everything it said and gains the block at the
 * end — appending twice is the failure this replaces.
 */
function merged(existing: string | undefined, marked: string): string {
  if (existing === undefined) return `${marked}\n`;
  const bounds = blockBounds(existing);
  if (bounds === undefined) return `${existing.trimEnd()}\n\n${marked}\n`;
  return `${existing.slice(0, bounds.start)}${marked}${existing.slice(bounds.end)}`;
}

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
