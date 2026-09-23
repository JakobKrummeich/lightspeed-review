import { classifyFile, type ClassifyConfig } from "../classify.ts";
import type { DiffGroup } from "../diff-extract.ts";
import type { GroupTier } from "../group-tier.ts";

/**
 * Raises a `sweep` chapter to `study` when any file is `guardrail` or any file
 * is not `mechanical`; never lowers a `study`. The asymmetry is the point: a
 * chapter wrongly raised costs the reviewer minutes, a chapter wrongly swept is
 * the change nobody looked at — the exact failure this feature exists to
 * prevent — so the rule does not try to balance the two.
 *
 * The code gets the last word because the marks are facts read off the diff and
 * `src/classify.ts`, the tier is a judgement about a chapter, and a judgement
 * that contradicts a fact loses. The model still decides what facts cannot
 * settle: a chapter of files every rule calls mechanical is swept only if the
 * model agreed — "nothing to decide here" is a claim about the change, not
 * about the file types in it.
 *
 * Total: a group that arrived without a tier (the `Tests` chapter `trailTests`
 * builds, a grouping from before tiers existed) leaves as `study`, which is the
 * same reading `isSweep` gives it anywhere else.
 */
export function raiseToStudy(groups: DiffGroup[], classify?: ClassifyConfig): DiffGroup[] {
  return groups.map((group) => ({ ...group, tier: tierOf(group, classify) }));
}

function tierOf(group: DiffGroup, classify?: ClassifyConfig): GroupTier {
  if (group.tier !== "sweep") return "study";
  const marks = group.files.map((file) => classifyFile(file, classify));
  // Stated as the two rules they are, although the classifier already suppresses
  // `mechanical` on a guardrail file: this module must keep saying no to a
  // guardrail chapter even if that suppression is ever relaxed.
  if (marks.some((mark) => mark.guardrail)) return "study";
  if (marks.some((mark) => !mark.mechanical)) return "study";
  return "sweep";
}
