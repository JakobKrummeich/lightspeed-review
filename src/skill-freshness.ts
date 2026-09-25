import type { StructuredOutput } from "./output.ts";
import {
  installSkill,
  knownSkillTargets,
  ownedSkillText,
  type InitRoots,
  type KnownTarget,
} from "./skill-install.ts";
import {
  compareVersions,
  isEdited,
  readStamp,
  renderedContentHash,
  stampedSkillFor,
} from "./skill-stamp.ts";
import { CLI_VERSION } from "./version.ts";

/** One installed skill this CLI would not stand behind, and the command that fixes it. */
export interface StaleSkill {
  path: string;
  problem: string;
  fix: string;
}

type Verdict = { kind: "current" } | { kind: "refresh" } | { kind: "stale"; problem: string };

/**
 * Runs before every command. An agent reads its skill once, at startup, and
 * trusts it; `lightspeed init` was the only thing that ever updated one, and
 * nobody re-ran it after an upgrade — so skills went on teaching verbs the CLI
 * had removed. A skill lightspeed stamped and nobody edited is rewritten here
 * without a word; any other lightspeed skill is left as it is and reported.
 *
 * Kept cheap enough to run on every call: no network, one read per known path
 * (ten at most), and a write only when a stamped skill is behind.
 */
export function refreshSkills(roots: InitRoots, version: string = CLI_VERSION): StaleSkill[] {
  return knownSkillTargets(roots).flatMap((known) => refreshOne(known, version));
}

function refreshOne(known: KnownTarget, version: string): StaleSkill[] {
  const owned = ownedSkillText(known.target);
  if (owned === undefined) return [];
  const verdict = judge(owned, known, version);
  if (verdict.kind === "current") return [];
  if (verdict.kind === "stale") return [staleSkill(known, verdict.problem)];
  return rewrite(known, version);
}

/**
 * The dialect comes from where the file lives, not from the stamp: that is
 * the agent that reads it.
 */
function judge(owned: string, known: KnownTarget, version: string): Verdict {
  const stamp = readStamp(owned);
  if (stamp === undefined) return { kind: "stale", problem: UNSTAMPED };
  if (isEdited(owned, stamp)) {
    return { kind: "stale", problem: `edited since lightspeed ${stamp.version} wrote it` };
  }
  if (compareVersions(stamp.version, version) > 0) {
    return {
      kind: "stale",
      problem: `written by lightspeed ${stamp.version}, newer than this ${version}`,
    };
  }
  if (stamp.content === renderedContentHash(known.agent)) return { kind: "current" };
  return { kind: "refresh" };
}

/**
 * Hand-written or pre-stamp look the same from here, and either may be
 * somebody's deliberate edit — which a silent rewrite would destroy.
 */
const UNSTAMPED =
  "no lightspeed version stamp: written by hand or by an older lightspeed," +
  " so it may teach commands this CLI no longer has";

/** A skill that could not be refreshed is a notice, never a failed command:
 * the review the agent came for does not depend on it. */
function rewrite(known: KnownTarget, version: string): StaleSkill[] {
  try {
    installSkill(known.target, stampedSkillFor(known.agent, version), false);
    return [];
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "write failed";
    return [staleSkill(known, `behind this ${version} and could not be rewritten (${code})`)];
  }
}

function staleSkill(known: KnownTarget, problem: string): StaleSkill {
  const scope = known.scope === "project" ? " --scope project" : "";
  return {
    path: known.target.path,
    problem,
    // The restart is half the fix: an agent reads its skill at startup only.
    fix: `lightspeed init --agent ${known.agent}${scope}, then restart your agent`,
  };
}

/** Nothing at all when nothing is stale, so a clean machine's answers read exactly as before. */
export function skillNoticeOutput(stale: StaleSkill[]): StructuredOutput {
  return stale.length === 0 ? {} : { skill_stale: stale };
}
