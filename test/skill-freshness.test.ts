import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { refreshSkills, skillNoticeOutput } from "../src/skill-freshness.ts";
import { stampedSkillFor, stampSkill } from "../src/skill-stamp.ts";
import { renderSkillFor } from "../src/skill.ts";

interface Roots {
  home: string;
  cwd: string;
}

/** A machine of its own: the real home holds the skills of whoever runs the suite. */
function roots(): Roots {
  const root = mkdtempSync(join(tmpdir(), "lsr-fresh-"));
  const place = { home: join(root, "home"), cwd: join(root, "repo") };
  mkdirSync(place.home, { recursive: true });
  mkdirSync(place.cwd, { recursive: true });
  return place;
}

function seed(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

const OLD_SKILL = "---\nname: lightspeed\ndescription: old\n---\n\nRun `lightspeed poll`.\n";

function piSkill(place: Roots): string {
  return join(place.home, ".pi/agent/skills/lightspeed/SKILL.md");
}

test("a skill lightspeed wrote at an older version is rewritten at this one, silently", () => {
  const place = roots();
  const path = seed(piSkill(place), stampSkill(OLD_SKILL, "2.0.0"));

  const stale = refreshSkills(place, "2.3.0");

  assert.deepEqual(stale, []);
  assert.equal(readFileSync(path, "utf8"), stampedSkillFor("pi", "2.3.0"));
});

/** Between releases the version stays put while main moves, and a clone
 * installed from main is still owed the skill its own help prints. */
test("a skill stamped with this very version but other content is rewritten too", () => {
  const place = roots();
  const path = seed(piSkill(place), stampSkill(OLD_SKILL, "2.3.0"));

  assert.deepEqual(refreshSkills(place, "2.3.0"), []);
  assert.equal(readFileSync(path, "utf8"), stampedSkillFor("pi", "2.3.0"));
});

test("a current skill is not written again", () => {
  const place = roots();
  const path = seed(piSkill(place), stampedSkillFor("pi", "2.3.0"));
  const before = statSync(path).mtimeMs;

  assert.deepEqual(refreshSkills(place, "2.3.0"), []);
  assert.equal(statSync(path).mtimeMs, before);
});

test("a skill whose content is current is left alone even when the version moved", () => {
  const place = roots();
  const current = stampedSkillFor("pi", "2.2.0");
  const path = seed(piSkill(place), current);

  assert.deepEqual(refreshSkills(place, "2.3.0"), []);
  assert.equal(readFileSync(path, "utf8"), current);
});

test("a skill with no stamp is left alone and reported with the command that fixes it", () => {
  const place = roots();
  const path = seed(piSkill(place), OLD_SKILL);

  const stale = refreshSkills(place, "2.3.0");

  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.path, path);
  assert.match(stale[0]!.problem, /no lightspeed version stamp/);
  assert.equal(stale[0]!.fix, "lightspeed init --agent pi, then restart your agent");
  assert.equal(readFileSync(path, "utf8"), OLD_SKILL);
});

test("a stamped skill somebody edited is reported and never overwritten", () => {
  const place = roots();
  const edited = stampedSkillFor("pi", "2.2.0").replace("Semantic", "My own");
  const path = seed(piSkill(place), edited);

  const stale = refreshSkills(place, "2.3.0");

  assert.match(stale[0]!.problem, /edited since lightspeed 2\.2\.0 wrote it/);
  assert.equal(readFileSync(path, "utf8"), edited);
});

/** Downgrading would teach verbs this CLI does not have either way; the notice
 * at least says which side is behind. */
test("a skill a newer lightspeed wrote is reported and never downgraded", () => {
  const place = roots();
  const newer = stampSkill(OLD_SKILL, "3.0.0");
  const path = seed(piSkill(place), newer);

  const stale = refreshSkills(place, "2.3.0");

  assert.match(stale[0]!.problem, /lightspeed 3\.0\.0, newer than this 2\.3\.0/);
  assert.equal(readFileSync(path, "utf8"), newer);
});

test(
  "a stale skill that cannot be rewritten is reported instead of failing the command",
  { skip: process.getuid?.() === 0 ? "root writes through a read-only mode" : false },
  () => {
    const place = roots();
    const path = seed(piSkill(place), stampSkill(OLD_SKILL, "2.0.0"));
    chmodSync(path, 0o444);

    const stale = refreshSkills(place, "2.3.0");

    assert.match(stale[0]!.problem, /could not be rewritten \(EACCES\)/);
    assert.equal(stale[0]!.fix, "lightspeed init --agent pi, then restart your agent");
  },
);

test("a marked block in a shared instructions file is refreshed and the prose around it kept", () => {
  const place = roots();
  const oldBlock = stampSkill("# lightspeed\n\nRun `lightspeed poll`.\n", "2.0.0", "codex");
  const path = seed(
    join(place.home, ".codex/AGENTS.md"),
    `# House rules\n\n<!-- lightspeed:start -->\n${oldBlock.trimEnd()}\n<!-- lightspeed:end -->\n\nRun the tests.\n`,
  );

  assert.deepEqual(refreshSkills(place, "2.3.0"), []);
  const contents = readFileSync(path, "utf8");
  assert.ok(contents.startsWith("# House rules\n\n<!-- lightspeed:start -->\n"));
  assert.ok(contents.includes(stampedSkillFor("codex", "2.3.0").trimEnd()));
  assert.ok(contents.endsWith("<!-- lightspeed:end -->\n\nRun the tests.\n"));
  assert.ok(!contents.includes("lightspeed poll"));
});

test("a shared instructions file with no lightspeed block is left alone and not reported", () => {
  const place = roots();
  const path = seed(join(place.home, ".codex/AGENTS.md"), "# House rules\n\nlightspeed is fun\n");

  assert.deepEqual(refreshSkills(place, "2.3.0"), []);
  assert.equal(readFileSync(path, "utf8"), "# House rules\n\nlightspeed is fun\n");
});

test("a block written before stamps existed is reported, once for the file two agents share", () => {
  const place = roots();
  const path = seed(
    join(place.cwd, "AGENTS.md"),
    `<!-- lightspeed:start -->\n${renderSkillFor("codex")}<!-- lightspeed:end -->\n`,
  );

  const stale = refreshSkills(place, "2.3.0");

  assert.equal(stale.length, 1);
  assert.equal(stale[0]!.path, path);
  assert.equal(
    stale[0]!.fix,
    "lightspeed init --agent codex --scope project, then restart your agent",
  );
});

test("project skills are looked for in the directory the command runs from", () => {
  const place = roots();
  const path = seed(join(place.cwd, ".claude/skills/lightspeed/SKILL.md"), OLD_SKILL);

  const stale = refreshSkills(place, "2.3.0");

  assert.equal(stale[0]!.path, path);
  assert.match(stale[0]!.fix, /^lightspeed init --agent claude-code --scope project/);
});

test("a home directory that does not exist reports nothing and writes nothing", () => {
  const place = { home: join(tmpdir(), "lsr-fresh-nowhere", "home"), cwd: roots().cwd };

  assert.deepEqual(refreshSkills(place, "2.3.0"), []);
});

test("the notice is absent when nothing is stale, so a clean machine's answers stay as they were", () => {
  assert.deepEqual(skillNoticeOutput([]), {});
  assert.deepEqual(skillNoticeOutput([{ path: "/p", problem: "x", fix: "y" }]), {
    skill_stale: [{ path: "/p", problem: "x", fix: "y" }],
  });
});
