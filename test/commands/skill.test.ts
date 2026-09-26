import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSkillArgs, runSkill } from "../../src/commands/skill.ts";
import { ReviewError } from "../../src/errors.ts";
import { renderSkill, SKILL_AGENTS } from "../../src/skill.ts";
import { readStamp, stampedSkillFor, stampSkill } from "../../src/skill-stamp.ts";
import { CLI_VERSION } from "../../src/version.ts";

test("pi and claude-code get the checked-in SKILL.md form, stamped", () => {
  for (const agent of ["pi", "claude-code"]) {
    const output = runSkill({ agent });
    assert.equal(output, stampSkill(renderSkill(), CLI_VERSION, agent), agent);
    assert.ok(output.startsWith("---\nname: lightspeed\n"), agent);
  }
});

/** A file redirected from `skill` is one a later CLI can refresh, the same as
 * one `init` wrote. */
test("every dialect is stamped with the version of the CLI that printed it", () => {
  for (const agent of SKILL_AGENTS) {
    assert.equal(readStamp(runSkill({ agent }))?.version, CLI_VERSION, agent);
  }
});

test("codex, opencode and vscode get plain markdown without frontmatter", () => {
  for (const agent of ["codex", "opencode", "vscode"]) {
    const output = runSkill({ agent });
    assert.match(output, /^<!-- written by lightspeed .*-->\n# lightspeed\n/m, agent);
    // Frontmatter is a leading `---` block, not any `---` anywhere: the body has a
    // markdown table in it, whose separator row is dashes too.
    assert.doesNotMatch(output, /^---$/m, `${agent} carries no frontmatter`);
    assert.doesNotMatch(output, /^name: lightspeed$/m, agent);
    assert.match(output, /## The loop/, agent);
    assert.match(output, /Use when work is ready for review/, agent);
  }
});

/** A copy appended to a shared AGENTS.md is then a block the freshness pass
 * owns, the same as one `init` merged in. */
test("codex, opencode and vscode get their skill between the lightspeed markers", () => {
  for (const agent of ["codex", "opencode", "vscode"] as const) {
    assert.equal(
      runSkill({ agent }),
      `<!-- lightspeed:start -->\n${stampedSkillFor(agent, CLI_VERSION).trimEnd()}\n<!-- lightspeed:end -->`,
      agent,
    );
  }
});

test("the plain dialect keeps every shared section", () => {
  const output = runSkill({ agent: "codex" });

  for (const heading of [
    "## The loop",
    "## The turn",
    "## What an item says",
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
