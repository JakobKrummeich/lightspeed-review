import { createHash } from "node:crypto";
import { renderSkillFor, type SkillAgent } from "./skill.ts";

/**
 * What an installed skill says about itself. `content` is a hash of the
 * skill as lightspeed wrote it, which is how a later CLI tells a file it may
 * replace from one somebody has since edited by hand: the stamp is copied
 * along with any edit, so its presence alone proves nothing.
 */
export interface SkillStamp {
  version: string;
  content: string;
}

/** One line, parsed by the CLI and read by a human who opens the file. The
 * agent id is for that human; the CLI takes the dialect from where the file
 * lives, since that is what the agent reading it expects. */
const STAMP_LINE = /^<!-- written by lightspeed (\S+) for \S+; content ([0-9a-f]{16}); .*-->\n?/m;

export function stampedSkillFor(agent: SkillAgent, version: string): string {
  return stampSkill(renderSkillFor(agent), version, agent);
}

/** Any text, so a test can reproduce the skill an older version wrote. */
export function stampSkill(rendered: string, version: string, agent = "pi"): string {
  const line =
    `<!-- written by lightspeed ${version} for ${agent}; content ${contentHash(rendered)};` +
    " a later lightspeed refreshes or reports it, and never overwrites an edit -->\n";
  const at = afterFrontmatter(rendered);
  return `${rendered.slice(0, at)}${line}${rendered.slice(at)}`;
}

export function readStamp(text: string): SkillStamp | undefined {
  const match = STAMP_LINE.exec(text);
  if (match === null) return undefined;
  return { version: match[1]!, content: match[2]! };
}

export function isEdited(text: string, stamp: SkillStamp): boolean {
  return contentHash(text.replace(STAMP_LINE, "")) !== stamp.content;
}

export function renderedContentHash(agent: SkillAgent): string {
  return contentHash(renderSkillFor(agent));
}

/**
 * Trimmed first: the skill reaches its file through `trimEnd` on the way out
 * of `lightspeed skill`, and between a block's markers on lines of its own —
 * neither the newlines around it nor a trailing one is an edit.
 */
function contentHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

/**
 * pi and Claude Code find a skill by the frontmatter at the very top of the
 * file, so the stamp goes under it rather than above.
 */
function afterFrontmatter(rendered: string): number {
  if (!rendered.startsWith("---\n")) return 0;
  const close = rendered.indexOf("\n---\n", 3);
  return close === -1 ? 0 : close + "\n---\n".length;
}

/**
 * major.minor.patch by number; a pre-release tag counts as its release, which
 * is close enough to decide whether a skill is behind the CLI reading it.
 */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function versionParts(version: string): number[] {
  const parts = version.split(/[-+]/)[0]!.split(".");
  return [0, 1, 2].map((index) => Number.parseInt(parts[index] ?? "", 10) || 0);
}
