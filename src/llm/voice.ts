import type { GroupingReply } from "./schema.ts";

/**
 * The voice a chapter's two sentences have to be written in, checked rather
 * than asked for. The system prompt has forbidden questions and orders in
 * detail since the fields existed, and models write them anyway — "Does the
 * change correctly distinguish...?" over a diff the reviewer has not opened,
 * "verify the intent is to split the cases" over a chapter they came to judge.
 * A rule the model keeps breaking is not a rule until something rejects the
 * reply, so this is the enforcement half of those prompt lines.
 *
 * It is deliberately blunt: it catches the shapes, not the meanings, and a
 * failure costs a repair round rather than the grouping (see `groupWithModel`).
 * That asymmetry is what lets it be strict — the worst a false rejection can do
 * is spend one more call.
 */

/**
 * Verbs that are only ever aimed at the reader in their bare form. A sentence
 * about code writes `verifies`, `checks`, `reviews`; the stem alone is someone
 * being told to do something, and the reviewer is the only someone here.
 */
const ORDERS = /\b(?:verify|ensure|confirm|validate|double-check|make sure)\b/i;

/**
 * The same, but only where a sentence opens — these have honest uses mid-clause
 * (`the check runs first`, `a note is dropped`) and none as an opening word,
 * where the mood is unavoidably imperative.
 */
const OPENING_ORDER = /^(?:check|review|watch|note|consider|look|see|ask|test|read)\b/i;

/** Nobody in this text is a "you": both sentences are about the code. */
const SECOND_PERSON = /\b(?:you|your|yours)\b/i;

/**
 * The first sentence of the pair that breaks the voice, named so the repair
 * message can quote it back. `undefined` when both are statements about code.
 */
export function voiceProblem(groups: GroupingReply["groups"]): string | undefined {
  for (const group of groups) {
    for (const field of ["rationale", "watch"] as const) {
      const fault = faultIn(group[field]);
      if (fault !== undefined) {
        return `the \`${field}\` of \`${group.name}\` is ${fault}, and both sentences must be statements about this group's own code: "${group[field]}"`;
      }
    }
  }
  return undefined;
}

/** What is wrong with one sentence, in the words the repair message uses. */
function faultIn(sentence: string): string | undefined {
  // Code the model quoted is the repository's vocabulary, not the model's: a
  // function named `verifyToken` is not an order to verify anything.
  const prose = sentence.replace(/`[^`]*`/g, " ");
  if (prose.includes("?")) return "a question the reviewer cannot answer before reading the diff";
  if (SECOND_PERSON.test(prose)) return "addressed to the reader";
  if (ORDERS.test(prose)) return "an order to the reader";
  if (clauses(prose).some((clause) => OPENING_ORDER.test(clause))) return "an order to the reader";
  return undefined;
}

/** Where a new mood can start: a sentence's beginning, and a clause's after it. */
function clauses(prose: string): string[] {
  return prose
    .split(/[.;:—]|\s-\s/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}
