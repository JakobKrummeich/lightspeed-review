import { test } from "node:test";
import assert from "node:assert/strict";
import { GROUPING_SCHEMA_JSON, validateGroupingReply } from "../../src/llm/schema.ts";

const paths = ["src/a.ts", "src/b.ts"];

function problemFor(reply: string): string {
  const result = validateGroupingReply(reply, paths);
  assert.equal(result.ok, false, `expected ${reply} to be rejected`);
  return result.problem;
}

test("accepts a reply that covers every file exactly once", () => {
  const result = validateGroupingReply(
    JSON.stringify({
      groups: [
        {
          name: "Core",
          rationale: "the change",
          watch: "the risk",
          tier: "study",
          files: ["src/a.ts"],
        },
        {
          name: "Tests",
          rationale: "coverage",
          watch: "the gap",
          tier: "study",
          files: ["src/b.ts"],
        },
      ],
    }),
    paths,
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.value.groups.map((group) => group.name), ["Core", "Tests"]);
});

test("accepts a reply wrapped in a markdown code fence", () => {
  const reply = `Here you go:\n\`\`\`json\n${JSON.stringify({
    groups: [
      { name: "All", rationale: "everything", watch: "the lot", tier: "study", files: paths },
    ],
  })}\n\`\`\``;

  assert.equal(validateGroupingReply(reply, paths).ok, true);
});

test("reports unparseable JSON", () => {
  assert.match(problemFor("{ groups: ["), /not valid JSON/);
});

test("reports a schema violation with the offending path", () => {
  const problem = problemFor(JSON.stringify({ groups: [{ name: 5, files: ["src/a.ts"] }] }));

  assert.match(problem, /schema/);
  assert.match(problem, /name/);
});

test("a group without its watch sentence is a schema violation, not a shrug", () => {
  const problem = problemFor(
    JSON.stringify({ groups: [{ name: "Core", rationale: "r", files: paths }] }),
  );

  assert.match(problem, /schema/);
  assert.match(problem, /watch/);
});

test("a group without its tier is a schema violation, not a defaulted answer", () => {
  // The model has read the files and is the only party that can say whether
  // there is anything in the chapter to judge; a default would be nobody's answer.
  const problem = problemFor(
    JSON.stringify({ groups: [{ name: "Core", rationale: "r", watch: "w", files: paths }] }),
  );

  assert.match(problem, /schema/);
  assert.match(problem, /tier/);
});

test("a tier that is neither of the two reading tiers is rejected", () => {
  const problem = problemFor(
    JSON.stringify({
      groups: [{ name: "Core", rationale: "r", watch: "w", tier: "skim", files: paths }],
    }),
  );

  assert.match(problem, /schema/);
  assert.match(problem, /tier/);
});

test("a swept chapter comes through as the model tiered it", () => {
  const result = validateGroupingReply(
    JSON.stringify({
      groups: [
        { name: "Core", rationale: "r", watch: "w", tier: "study", files: ["src/a.ts"] },
        { name: "Renames", rationale: "r", watch: "w", tier: "sweep", files: ["src/b.ts"] },
      ],
    }),
    paths,
  );

  assert.deepEqual(result.ok && result.value.groups.map((group) => group.tier), ["study", "sweep"]);
});

test("rejects an empty group list", () => {
  assert.match(problemFor(JSON.stringify({ groups: [] })), /schema/);
});

test("reports files that were left out", () => {
  const problem = problemFor(
    JSON.stringify({
      groups: [{ name: "Core", rationale: "r", watch: "w", tier: "study", files: ["src/a.ts"] }],
    }),
  );

  assert.match(problem, /missing/);
  assert.match(problem, /src\/b\.ts/);
});

test("reports invented files that are not in the diff", () => {
  const problem = problemFor(
    JSON.stringify({
      groups: [
        {
          name: "Core",
          rationale: "r",
          watch: "w",
          tier: "study",
          files: [...paths, "src/ghost.ts"],
        },
      ],
    }),
  );

  assert.match(problem, /not in the diff/);
  assert.match(problem, /src\/ghost\.ts/);
});

test("reports files listed in more than one group", () => {
  const problem = problemFor(
    JSON.stringify({
      groups: [
        { name: "Core", rationale: "r", watch: "w", tier: "study", files: paths },
        { name: "Extra", rationale: "r", watch: "w", tier: "study", files: ["src/a.ts"] },
      ],
    }),
  );

  assert.match(problem, /more than one group/);
  assert.match(problem, /src\/a\.ts/);
});

test("the inlined schema documents the ordered array contract without an order field", () => {
  assert.match(GROUPING_SCHEMA_JSON, /"groups"/);
  assert.match(GROUPING_SCHEMA_JSON, /"rationale"/);
  assert.match(GROUPING_SCHEMA_JSON, /"watch"/);
  // The model reads the two tiers off the schema itself, so they are inlined too.
  assert.match(GROUPING_SCHEMA_JSON, /"tier"/);
  assert.match(GROUPING_SCHEMA_JSON, /"study"/);
  assert.match(GROUPING_SCHEMA_JSON, /"sweep"/);
  assert.ok(!GROUPING_SCHEMA_JSON.includes('"order"'));
});

test("schema-keyword junk at the top level is shed, not repaired", () => {
  // Small models echo fragments of the inlined JSON schema around their answer;
  // the grouping inside is complete, and a repair round would teach it nothing.
  const reply = JSON.stringify({
    type: "object",
    $schema: "http://json-schema.org/draft-07/schema#",
    groups: [
      { name: "All", rationale: "Everything.", watch: "The lot.", tier: "study", files: ["a.ts"] },
    ],
  });
  const verdict = validateGroupingReply(reply, ["a.ts"]);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.ok && verdict.value.groups[0]?.name, "All");
});

test("a reply missing its groups still reads as the missing-groups problem", () => {
  const verdict = validateGroupingReply(JSON.stringify({ type: "object" }), ["a.ts"]);
  assert.equal(verdict.ok, false);
  assert.match(!verdict.ok ? verdict.problem : "", /groups/);
});
