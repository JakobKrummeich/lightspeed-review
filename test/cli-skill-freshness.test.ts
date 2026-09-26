import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { newRepo } from "./helpers/git-repo.ts";
import { stampedSkillFor, stampSkill } from "../src/skill-stamp.ts";
import { CLI_VERSION } from "../src/version.ts";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** The skill pi read before `poll` was removed: no stamp, and a verb that no longer exists. */
const PRE_STAMP_SKILL =
  "---\nname: lightspeed\ndescription: old\n---\n\nRun `lightspeed poll --agent-reply`.\n";

async function runCli(args: string[], home: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: newRepo("lsr-cli-fresh-"),
      env: { ...process.env, HOME: home },
    });
    return { stdout, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; code?: number };
    return { stdout: failure.stdout ?? "", code: failure.code ?? 1 };
  }
}

/** A home directory holding one pi skill with the given contents. */
function homeWithPiSkill(contents: string): { home: string; skill: string } {
  const home = mkdtempSync(join(tmpdir(), "lsr-cli-fresh-home-"));
  const skill = join(home, ".pi/agent/skills/lightspeed/SKILL.md");
  mkdirSync(dirname(skill), { recursive: true });
  writeFileSync(skill, contents);
  return { home, skill };
}

/** `poll` is exactly what an agent on the pre-stamp skill runs, so the refusal
 * it gets is where the notice has to be. */
test("an unknown command answers with skill_stale while the installed skill has no stamp", async () => {
  const { home, skill } = homeWithPiSkill(PRE_STAMP_SKILL);

  const { stdout, code } = await runCli(["poll"], home);

  assert.equal(code, 2);
  assert.match(stdout, /^error:$/m);
  assert.match(stdout, /^skill_stale\[1\]\{path,problem,fix\}:$/m);
  assert.ok(stdout.includes(skill));
  assert.ok(stdout.includes("lightspeed init --agent pi, then restart your agent"));
});

test("a failed command carries skill_stale beside its error", async () => {
  const { home } = homeWithPiSkill(PRE_STAMP_SKILL);

  const { stdout, code } = await runCli(["reply"], home);

  assert.equal(code, 2);
  assert.match(stdout, /code: argument_missing/);
  assert.match(stdout, /^skill_stale\[1\]/m);
});

test("a successful command carries skill_stale after its own answer", async () => {
  const { home } = homeWithPiSkill(PRE_STAMP_SKILL);

  const { stdout, code } = await runCli([], home);

  assert.equal(code, 0);
  assert.match(stdout, /^repo: /m);
  assert.match(stdout, /^skill_stale\[1\]/m);
});

test("any command rewrites a skill an older lightspeed stamped, and says nothing about it", async () => {
  const { home, skill } = homeWithPiSkill(stampSkill(PRE_STAMP_SKILL, "0.0.1"));

  const { stdout, code } = await runCli([], home);

  assert.equal(code, 0);
  assert.doesNotMatch(stdout, /skill_stale/);
  assert.equal(readFileSync(skill, "utf8"), stampedSkillFor("pi", CLI_VERSION));
});

/** `--dry-run` promises to write nothing, and a refresh of another agent's skill
 * is still a write. */
test("init --dry-run leaves an older stamped skill as it was", async () => {
  const old = stampSkill(PRE_STAMP_SKILL, "0.0.1");
  const { home, skill } = homeWithPiSkill(old);

  const { code } = await runCli(["init", "--agent", "claude-code", "--dry-run"], home);

  assert.equal(code, 0);
  assert.equal(readFileSync(skill, "utf8"), old);
});

/** stdout is redirected into an agent's file, where a TOON notice would be a
 * line of garbage in the skill itself. */
test("skill prints the document alone, even while another skill is stale", async () => {
  const { home } = homeWithPiSkill(PRE_STAMP_SKILL);

  const { stdout, code } = await runCli(["skill", "--agent", "codex"], home);

  assert.equal(code, 0);
  assert.equal(
    stdout,
    `<!-- lightspeed:start -->\n${stampedSkillFor("codex", CLI_VERSION).trimEnd()}\n<!-- lightspeed:end -->\n`,
  );
});

/** An agent on a stale skill reaches for help when a verb it was taught fails. */
test("the top-level help carries skill_stale, asked for either way", async () => {
  const { home } = homeWithPiSkill(PRE_STAMP_SKILL);

  for (const args of [["--help"], ["help"]]) {
    const { stdout, code } = await runCli(args, home);

    assert.equal(code, 0, args.join(" "));
    assert.match(stdout, /^commands:$/m, args.join(" "));
    assert.match(stdout, /^skill_stale\[1\]\{path,problem,fix\}:$/m, args.join(" "));
  }
});

test("a command's help carries skill_stale, asked for either way", async () => {
  const { home } = homeWithPiSkill(PRE_STAMP_SKILL);

  for (const args of [
    ["open", "--help"],
    ["help", "open"],
  ]) {
    const { stdout, code } = await runCli(args, home);

    assert.equal(code, 0, args.join(" "));
    assert.match(stdout, /^command: open$/m, args.join(" "));
    assert.match(stdout, /^skill_stale\[1\]\{path,problem,fix\}:$/m, args.join(" "));
  }
});

test("help reads as before when no installed skill is stale", async () => {
  const { home } = homeWithPiSkill(stampedSkillFor("pi", CLI_VERSION));

  for (const args of [["--help"], ["open", "--help"]]) {
    const { stdout } = await runCli(args, home);

    assert.doesNotMatch(stdout, /skill_stale/, args.join(" "));
  }
});
