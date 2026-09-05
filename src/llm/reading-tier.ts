import { classifyFile, type ClassifyConfig } from "../classify.ts";
import type { DiffGroup } from "../diff-extract.ts";
import type { GroupTier } from "../group-tier.ts";

/**
 * The code's last word on how a chapter is read, and it has that word in one
 * direction only: a chapter the model called `sweep` is raised to `study` when
 * any of its files is `guardrail`, or when any of its files is not `mechanical`.
 * A chapter the model called `study` is never lowered, whatever the marks say.
 *
 * That asymmetry is the whole point rather than a missing half. Automation here
 * may add reading and never remove it: a chapter wrongly raised costs the
 * reviewer the minutes it takes to read files that turned out to be bulk, while
 * a chapter wrongly swept is the change nobody looked at — the exact failure
 * this feature exists to prevent. The two costs are not comparable, so the rule
 * does not try to balance them.
 *
 * It is also why the code, and not the model, gets the last word at all. The
 * marks are facts read off the diff and the repository's own configuration
 * (`src/classify.ts`), the tier is a judgement made about a chapter of files,
 * and a judgement that contradicts a fact loses. What the model still decides
 * is everything the facts cannot settle: a chapter of files every rule calls
 * mechanical is only swept if the model agreed it was, because "nothing to
 * decide here" is a claim about the change and not about the file types in it.
 *
 * Pure and total: same groups in, same groups out, every one of them carrying
 * an explicit tier. A group that arrived without one — the `Tests` chapter
 * `trailTests` builds, a grouping from before tiers existed — leaves as
 * `study`, which is the same reading `isSweep` gives it anywhere else.
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
