import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

/**
 * The grouping contract. Order is the array position — there is deliberately no
 * `order` field for the model to contradict itself with.
 *
 * `tier` is required rather than defaulted, because a default would be a tier
 * nobody chose: the model has read every file of the chapter and is the only
 * party here that can say whether there is anything in it to judge. What it
 * answers is then held against the inventory's own marks by
 * `src/llm/reading-tier.ts`, which may raise a chapter and never lower one.
 */
export const GROUPING_SCHEMA = Type.Object(
  {
    groups: Type.Array(
      Type.Object({
        name: Type.String({ minLength: 1 }),
        rationale: Type.String({ minLength: 1 }),
        tier: Type.Union([Type.Literal("study"), Type.Literal("sweep")]),
        files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      }),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export type GroupingReply = Static<typeof GROUPING_SCHEMA>;

/**
 * Inlined into the *system* prompt so the model sees the exact contract while
 * the per-call user message stays pure data — which keeps the whole instruction
 * prefix identical between calls, and so cacheable.
 */
export const GROUPING_SCHEMA_JSON = JSON.stringify(GROUPING_SCHEMA, null, 2);

/** An accepted reply: the groups exactly as the model sent them. */
export interface ValidatedGrouping {
  groups: GroupingReply["groups"];
}

export type GroupingValidation =
  | { ok: true; value: ValidatedGrouping }
  /** `problem` is fed back to the model verbatim as the repair message. */
  | { ok: false; problem: string };

/** LLM output is never trusted: parse, then schema, then diff coverage. */
export function validateGroupingReply(reply: string, paths: string[]): GroupingValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(reply));
  } catch (error) {
    return { ok: false, problem: `your reply is not valid JSON: ${(error as Error).message}` };
  }
  const grouping = onlyGroups(parsed);
  if (!Check(GROUPING_SCHEMA, grouping)) {
    return {
      ok: false,
      problem: `your reply does not match the schema: ${schemaProblem(grouping)}`,
    };
  }
  const coverage = coverageProblem(grouping, paths);
  if (coverage !== undefined) return { ok: false, problem: coverage };
  return { ok: true, value: { groups: grouping.groups } };
}

/**
 * Sheds every top-level key but `groups` before the schema check: small models
 * echo fragments of the inlined schema (`type`, `$schema`) around a complete
 * answer, and a repair round over that junk teaches nothing. Non-objects pass
 * through as-is; a missing `groups` still reads as exactly that.
 */
function onlyGroups(parsed: unknown): unknown {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  return "groups" in record ? { groups: record.groups } : {};
}

/** Models like to wrap JSON in ```json fences; that alone is not worth a repair round. */
function stripCodeFence(reply: string): string {
  const fenced = reply.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  return (fenced?.[1] ?? reply).trim();
}

function schemaProblem(parsed: unknown): string {
  const problems = [...Errors(GROUPING_SCHEMA, parsed)]
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message}`);
  return problems.join("; ");
}

function coverageProblem(reply: GroupingReply, paths: string[]): string | undefined {
  const grouped = reply.groups.flatMap((group) => group.files);
  const expected = new Set(paths);
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const path of grouped) {
    if (seen.has(path)) duplicated.add(path);
    seen.add(path);
  }
  const invented = grouped.filter((path) => !expected.has(path));
  const missing = paths.filter((path) => !seen.has(path));

  if (missing.length > 0) return `these files are missing from your groups: ${list(missing)}`;
  if (invented.length > 0) return `these files are not in the diff: ${list(invented)}`;
  if (duplicated.size > 0)
    return `these files appear in more than one group: ${list([...duplicated])}`;
  return undefined;
}

function list(paths: string[]): string {
  return paths.join(", ");
}
