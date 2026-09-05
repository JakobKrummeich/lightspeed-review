import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillArgs, runSkill } from "../../src/commands/skill.ts";
import { ReviewError } from "../../src/errors.ts";
import { renderSkill, SKILL_AGENTS } from "../../src/skill.ts";

test("pi and claude-code get exactly the checked-in SKILL.md form", () => {
  for (const agent of ["pi", "claude-code"]) {
    const output = runSkill({ agent });
    assert.equal(output, renderSkill(), agent);
    assert.ok(output.startsWith("---\nname: lightspeed\n"), agent);
  }
});

test("codex, opencode and vscode get plain markdown without frontmatter", () => {
  for (const agent of ["codex", "opencode", "vscode"]) {
    const output = runSkill({ agent });
    assert.ok(output.startsWith("# lightspeed\n"), agent);
    assert.ok(!output.includes("---"), `${agent} carries no frontmatter`);
    assert.match(output, /## The loop/, agent);
    assert.match(output, /Use when work is ready for review/, agent);
  }
});

test("the plain dialect keeps every shared section", () => {
  const output = runSkill({ agent: "codex" });

  for (const heading of [
    "## The loop",
    "## What a prompt says",
    "## Rules",
    "## Setup",
    "## Output",
  ]) {
    assert.ok(output.includes(heading), heading);
  }
});

test("the default agent is pi", () => {
  assert.deepEqual(parseSkillArgs([]), { agent: "pi" });
});

test("--agent picks the dialect", () => {
  assert.deepEqual(parseSkillArgs(["--agent", "codex"]), { agent: "codex" });
});

test("an unknown agent is invalid_arguments naming all five ids", () => {
  assert.throws(
    () => runSkill({ agent: "cursor" }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "invalid_arguments" &&
      SKILL_AGENTS.every((id) => error.detail?.includes(id) === true),
  );
});

test("an unknown flag fails loudly instead of being swallowed", () => {
  assert.throws(
    () => parseSkillArgs(["--agents", "pi"]),
    (error: unknown) => error instanceof Error && /unknown flag --agents/.test(error.message),
  );
});

test("--agent without a value is refused at the flag", () => {
  assert.throws(
    () => parseSkillArgs(["--agent"]),
    (error: unknown) => error instanceof Error && /--agent needs a value/.test(error.message),
  );
});

test("a positional agent id is refused, pointing at --agent", () => {
  assert.throws(
    () => parseSkillArgs(["codex"]),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "invalid_arguments" &&
      error.suggestions.some((line) => line.includes("--agent codex")),
  );
});
