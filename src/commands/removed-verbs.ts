import { ReviewError } from "../errors.ts";

/**
 * 2.x verbs, answered rather than unknown: an agent still running a stale
 * skill is told the verb went and where its next step is.
 */
export const REMOVED_VERBS = ["wait", "ask", "say", "start"] as const;

export type RemovedVerb = (typeof REMOVED_VERBS)[number];

const INSTEAD: Record<RemovedVerb, string> = {
  wait: "`open`, `reply` and `publish` wait for the reviewer's Send themselves; re-run the one that was waiting",
  ask: "questions and answers are one call now: `lightspeed reply --to <id> '<text>'`",
  say: "questions and answers are one call now: `lightspeed reply --to <id> '<text>'`",
  start: "`lightspeed open` starts a review; `lightspeed publish` opens the next round",
};

export function removedVerb(verb: RemovedVerb): never {
  throw new ReviewError({
    code: "removed_verb",
    message: `'${verb}' was removed in 3.0, run lightspeed for your next step`,
    detail: INSTEAD[verb],
    suggestions: ["Run `lightspeed` (no arguments): it names the one command to run next"],
  });
}
