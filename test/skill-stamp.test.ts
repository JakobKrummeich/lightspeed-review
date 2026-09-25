import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  isEdited,
  readStamp,
  stampedSkillFor,
  stampSkill,
} from "../src/skill-stamp.ts";
import { renderSkill, renderSkillFor } from "../src/skill.ts";

test("a stamped skill names the lightspeed version that wrote it", () => {
  const stamp = readStamp(stampedSkillFor("pi", "2.3.0"));

  assert.equal(stamp?.version, "2.3.0");
});

/** A skill loader reads the frontmatter off the top of the file; a comment
 * above it would hide the skill's name from pi and Claude Code. */
test("the stamp sits under the frontmatter, so skill loaders still find the name first", () => {
  const stamped = stampedSkillFor("claude-code", "2.3.0");

  assert.match(
    stamped,
    /^---\nname: lightspeed\ndescription: .+\n---\n<!-- written by lightspeed 2\.3\.0 /,
  );
});

test("the plain dialect opens with the stamp", () => {
  const stamped = stampedSkillFor("codex", "2.3.0");

  assert.match(stamped, /^<!-- written by lightspeed 2\.3\.0 for codex; .*-->\n# lightspeed\n/);
});

test("the stamp is the only thing it adds to the rendered skill", () => {
  const stamped = stampedSkillFor("pi", "2.3.0");
  const withoutStampLine = stamped
    .split("\n")
    .filter((line) => !line.startsWith("<!-- written by lightspeed"))
    .join("\n");

  assert.equal(withoutStampLine, renderSkill());
});

test("a skill with no stamp reads as unstamped", () => {
  assert.equal(readStamp(renderSkill()), undefined);
  assert.equal(readStamp("# my own notes about lightspeed\n"), undefined);
});

test("a stamped skill nobody touched reads as unedited", () => {
  const stamped = stampedSkillFor("opencode", "2.3.0");

  assert.equal(isEdited(stamped, readStamp(stamped)!), false);
});

/** The stamp is compared against content that went through `trimEnd` on its way
 * into a block or out of `lightspeed skill`, so trailing whitespace is not an edit. */
test("trailing whitespace added on the way into a file is not an edit", () => {
  const stamped = stampedSkillFor("vscode", "2.3.0");

  assert.equal(isEdited(`${stamped.trimEnd()}\n\n`, readStamp(stamped)!), false);
});

test("a stamped skill with one word changed reads as edited", () => {
  const stamped = stampedSkillFor("pi", "2.3.0");
  const edited = stamped.replace("Semantic diff review", "Semantic code review");

  assert.equal(isEdited(edited, readStamp(stamped)!), true);
});

test("any text can be stamped, so an older skill's wording can be reproduced", () => {
  const old = stampSkill("---\nname: lightspeed\n---\n\nrun lightspeed poll\n", "2.0.0");

  assert.equal(readStamp(old)?.version, "2.0.0");
  assert.equal(isEdited(old, readStamp(old)!), false);
  assert.notEqual(readStamp(old)?.content, readStamp(stampedSkillFor("pi", "2.0.0"))?.content);
});

test("two dialects rendered by one version carry different content stamps", () => {
  assert.notEqual(
    readStamp(stampedSkillFor("pi", "2.3.0"))?.content,
    readStamp(stampedSkillFor("codex", "2.3.0"))?.content,
  );
  assert.ok(stampedSkillFor("codex", "2.3.0").includes(renderSkillFor("codex")));
});

test("versions compare by number, not as text", () => {
  assert.ok(compareVersions("2.10.0", "2.9.0") > 0);
  assert.ok(compareVersions("2.2.0", "3.0.0") < 0);
  assert.equal(compareVersions("2.2.0", "2.2.0"), 0);
  assert.equal(compareVersions("3.0.0-rc.1", "3.0.0"), 0);
});
