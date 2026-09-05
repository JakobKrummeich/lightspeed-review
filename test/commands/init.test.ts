import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseInitArgs, runInit, type InitInput } from "../../src/commands/init.ts";
import { ReviewError } from "../../src/errors.ts";
import type { StructuredOutput } from "../../src/output.ts";
import { renderSkill, renderSkillFor, SKILL_AGENTS } from "../../src/skill.ts";

interface Roots {
  home: string;
  cwd: string;
}

/**
 * A machine of its own. `init` writes into a home directory and a working
 * directory, so a test that used the real ones would rewrite the skills of the
 * developer running the suite.
 */
function roots(): Roots {
  const root = mkdtempSync(join(tmpdir(), "lsr-init-"));
  const place = { home: join(root, "home"), cwd: join(root, "repo") };
  mkdirSync(place.home, { recursive: true });
  mkdirSync(place.cwd, { recursive: true });
  return place;
}

function run(place: Roots, input: Partial<InitInput> = {}): StructuredOutput {
  return runInit({
    agent: "pi",
    scope: undefined,
    config: false,
    dryRun: false,
    ...place,
    ...input,
  });
}

interface Report {
  path: string;
  status: string;
  mode?: string;
}

function skill(output: StructuredOutput): Report {
  return output.skill as Report;
}

function seed(path: string, contents: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

test("no --agent and nothing else is agent_missing, named before anything is written", () => {
  const place = roots();

  assert.throws(
    () => run(place, { agent: undefined }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "agent_missing" &&
      SKILL_AGENTS.every((id) => error.detail?.includes(id) === true),
  );
  assert.deepEqual(readdirSync(place.home), []);
});

/** The error has to teach both ways out, not just the one it is named after. */
test("agent_missing says --config on its own is a thing you can run", () => {
  assert.throws(
    () => run(roots(), { agent: undefined }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.message.includes("--config") &&
      error.detail?.includes("--config") === true &&
      error.suggestions.some((line) => line.includes("lightspeed init --config")),
  );
});

/**
 * Which of five files a skill goes in is a guess with four wrong answers; where
 * the config goes is not a guess at all, so `--config` stands on its own.
 */
test("--config alone writes the config and no skill at all", () => {
  const place = roots();

  const output = run(place, { agent: undefined, config: true });

  assert.equal((output.config as Report).status, "written");
  assert.equal(existsSync(join(place.cwd, ".lightspeed.conf.json")), true);
  assert.equal(output.skill, undefined, "no skill block");
  assert.equal(output.init, undefined, "no agent or scope to report");
  assert.deepEqual(readdirSync(place.home), [], "nothing written for any agent");
});

/** Restarting buys nothing when no skill was written; the line would be a lie. */
test("--config alone never tells you to restart your agent", () => {
  const help = run(roots(), { agent: undefined, config: true }).help as string[];

  assert.ok(!help.some((line) => /restart/i.test(line)));
  assert.ok(help.some((line) => line.includes("placeholder")));
});

test("--config alone is idempotent and never clobbers a config", () => {
  const place = roots();
  const target = seed(join(place.cwd, ".lightspeed.conf.json"), '{"model": "mine"}');

  const output = run(place, { agent: undefined, config: true });

  assert.equal((output.config as Report).status, "exists");
  assert.equal(readFileSync(target, "utf8"), '{"model": "mine"}');
});

test("--config alone respects --dry-run", () => {
  const place = roots();

  const output = run(place, { agent: undefined, config: true, dryRun: true });

  assert.equal((output.config as Report).status, "written");
  assert.equal(output.dryRun, true);
  assert.equal(existsSync(join(place.cwd, ".lightspeed.conf.json")), false);
});

/** `--scope` only decides where a skill goes, so with no agent it decides nothing. */
test("--scope without --agent is refused instead of quietly doing nothing", () => {
  const place = roots();

  assert.throws(
    () => run(place, { agent: undefined, config: true, scope: "project" }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "invalid_arguments" &&
      error.message.includes("--agent"),
  );
  assert.equal(existsSync(join(place.cwd, ".lightspeed.conf.json")), false);
});

test("an unknown agent is invalid_arguments naming all five ids", () => {
  assert.throws(
    () => run(roots(), { agent: "cursor" }),
    (error: unknown) => error instanceof ReviewError && error.code === "invalid_arguments",
  );
});

test("an unknown scope is invalid_arguments naming both scopes", () => {
  assert.throws(
    () => run(roots(), { scope: "machine" }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "invalid_arguments" &&
      error.detail?.includes("global") === true &&
      error.detail?.includes("project") === true,
  );
});

/** The path pi actually scans is `~/.pi/agent/skills`, not `~/.pi/skills`. */
test("pi writes the SKILL.md form where pi scans for skills", () => {
  const place = roots();

  const output = run(place, { agent: "pi" });

  const target = join(place.home, ".pi/agent/skills/lightspeed/SKILL.md");
  assert.equal(skill(output).path, target);
  assert.equal(skill(output).status, "written");
  assert.equal(readFileSync(target, "utf8"), renderSkill());
});

test("--scope project writes into the repository pi reads it from", () => {
  const place = roots();

  const output = run(place, { agent: "pi", scope: "project" });

  assert.equal(skill(output).path, join(place.cwd, ".pi/skills/lightspeed/SKILL.md"));
  assert.equal(readFileSync(skill(output).path, "utf8"), renderSkill());
});

test("claude-code gets its own skills directory, global and project", () => {
  const global = roots();
  const project = roots();

  const globalOutput = run(global, { agent: "claude-code" });
  const projectOutput = run(project, { agent: "claude-code", scope: "project" });

  assert.equal(skill(globalOutput).path, join(global.home, ".claude/skills/lightspeed/SKILL.md"));
  assert.equal(skill(projectOutput).path, join(project.cwd, ".claude/skills/lightspeed/SKILL.md"));
  assert.equal(readFileSync(skill(globalOutput).path, "utf8"), renderSkill());
});

test("the block agents write to the instructions file each of them reads", () => {
  const place = roots();

  const codex = run(place, { agent: "codex" });
  const opencode = run(place, { agent: "opencode" });
  const vscode = run(place, { agent: "vscode", scope: "project" });

  assert.equal(skill(codex).path, join(place.home, ".codex/AGENTS.md"));
  assert.equal(skill(opencode).path, join(place.home, ".config/opencode/AGENTS.md"));
  assert.equal(skill(vscode).path, join(place.cwd, ".github/copilot-instructions.md"));
  assert.equal(skill(codex).mode, "block");
  assert.equal(skill(vscode).mode, "block");
});

test("codex and opencode share AGENTS.md in a repository", () => {
  const place = roots();

  const codex = run(place, { agent: "codex", scope: "project" });
  const opencode = run(place, { agent: "opencode", scope: "project" });

  assert.equal(skill(codex).path, join(place.cwd, "AGENTS.md"));
  assert.equal(skill(opencode).path, join(place.cwd, "AGENTS.md"));
});

/** Copilot reads instructions per repository; there is no file to write globally. */
test("vscode has no global instructions file and says so instead of inventing one", () => {
  assert.throws(
    () => run(roots(), { agent: "vscode", scope: "global" }),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "invalid_arguments" &&
      error.suggestions.some((line) => line.includes("--scope project")),
  );
});

test("a whole-file target is rewritten only when it differs", () => {
  const place = roots();

  const first = run(place, { agent: "pi" });
  const second = run(place, { agent: "pi" });
  seed(skill(first).path, "stale guidance\n");
  const third = run(place, { agent: "pi" });

  assert.equal(skill(first).status, "written");
  assert.equal(skill(second).status, "unchanged");
  assert.equal(skill(third).status, "updated");
  assert.equal(readFileSync(skill(third).path, "utf8"), renderSkill());
});

test("a marked block is replaced in place, never appended twice", () => {
  const place = roots();

  const first = run(place, { agent: "codex", scope: "project" });
  const second = run(place, { agent: "codex", scope: "project" });
  const contents = readFileSync(skill(first).path, "utf8");

  assert.equal(skill(first).status, "written");
  assert.equal(skill(second).status, "unchanged");
  assert.equal(contents.split("<!-- lightspeed:start -->").length - 1, 1);
  assert.equal(contents.split("<!-- lightspeed:end -->").length - 1, 1);
  assert.match(contents, /# lightspeed/);
});

test("an instructions file that was there already keeps everything it said", () => {
  const place = roots();
  const target = seed(join(place.cwd, "AGENTS.md"), "# House rules\n\nRun the tests.\n");

  const output = run(place, { agent: "codex", scope: "project" });
  const contents = readFileSync(target, "utf8");

  assert.equal(skill(output).status, "updated");
  assert.match(contents, /^# House rules$/m);
  assert.match(contents, /^Run the tests\.$/m);
  assert.ok(contents.indexOf("Run the tests.") < contents.indexOf("<!-- lightspeed:start -->"));
});

test("a stale block is refreshed without disturbing the prose around it", () => {
  const place = roots();
  const target = seed(
    join(place.cwd, "AGENTS.md"),
    "# House rules\n\n<!-- lightspeed:start -->\nold guidance\n<!-- lightspeed:end -->\n\nRun the tests.\n",
  );

  const output = run(place, { agent: "codex", scope: "project" });
  const contents = readFileSync(target, "utf8");

  assert.equal(skill(output).status, "updated");
  assert.ok(!contents.includes("old guidance"));
  assert.match(contents, /^# House rules$/m);
  assert.ok(contents.indexOf("<!-- lightspeed:end -->") < contents.indexOf("Run the tests."));
  assert.equal(skill(run(place, { agent: "codex", scope: "project" })).status, "unchanged");
});

test("the block carries the plain dialect, frontmatter and all removed", () => {
  const place = roots();

  const output = run(place, { agent: "codex", scope: "project" });
  const contents = readFileSync(skill(output).path, "utf8");

  assert.ok(contents.includes(renderSkillFor("codex").trimEnd()));
  assert.ok(!contents.includes("name: lightspeed"));
});

test("--dry-run reports the target and writes nothing at all", () => {
  const place = roots();

  const output = run(place, { agent: "pi", dryRun: true });

  assert.equal(skill(output).path, join(place.home, ".pi/agent/skills/lightspeed/SKILL.md"));
  assert.equal(skill(output).status, "written");
  assert.equal(output.dryRun, true);
  assert.equal(existsSync(skill(output).path), false);
  assert.ok((output.help as string[]).some((line) => line.includes("--dry-run")));
});

test("--dry-run over an installed skill reports it unchanged", () => {
  const place = roots();

  run(place, { agent: "pi" });
  const output = run(place, { agent: "pi", dryRun: true });

  assert.equal(skill(output).status, "unchanged");
});

test("--config writes a starter config the loader accepts", () => {
  const place = roots();

  const output = run(place, { agent: "pi", config: true });
  const report = output.config as Report;

  assert.equal(report.path, join(place.cwd, ".lightspeed.conf.json"));
  assert.equal(report.status, "written");
  assert.deepEqual(JSON.parse(readFileSync(report.path, "utf8")), {
    model: "<provider/model>",
    thinking: "off",
  });
  assert.ok((output.help as string[]).some((line) => line.includes("placeholder")));
});

test("--config never overwrites a config that is already there", () => {
  const place = roots();
  const target = seed(
    join(place.cwd, ".lightspeed.conf.json"),
    '{"model": "anthropic/claude-sonnet-4-5", "thinking": "high"}',
  );

  const output = run(place, { agent: "pi", config: true });

  assert.equal((output.config as Report).status, "exists");
  assert.match(readFileSync(target, "utf8"), /claude-sonnet-4-5/);
  assert.equal(skill(output).status, "written", "the skill is still installed");
  assert.ok((output.help as string[]).some((line) => line.includes(".lightspeed.conf.json")));
});

test("--config in a dry run writes no config either", () => {
  const place = roots();

  const output = run(place, { agent: "pi", config: true, dryRun: true });

  assert.equal(existsSync((output.config as Report).path), false);
});

test("without --config nothing is said about a config file", () => {
  assert.equal(run(roots(), { agent: "pi" }).config, undefined);
});

/** Skills are scanned at startup, so a running session cannot see what init wrote. */
test("help says to restart the agent before the skill counts", () => {
  const help = run(roots(), { agent: "pi" }).help as string[];

  assert.ok(help.some((line) => /restart/i.test(line) && line.includes("/reload")));
  assert.ok(help.some((line) => line.includes("lightspeed start")));
});

test("the report names the agent and the scope it wrote for", () => {
  const output = run(roots(), { agent: "codex", scope: "project" });

  assert.deepEqual(output.init, { agent: "codex", scope: "project" });
});

test("--agent and --scope are read off the command line, an absent scope left absent", () => {
  assert.deepEqual(parseInitArgs(["--agent", "codex"]), {
    agent: "codex",
    scope: undefined,
    config: false,
    dryRun: false,
  });
  assert.deepEqual(
    parseInitArgs(["--agent", "pi", "--scope", "project", "--config", "--dry-run"]),
    {
      agent: "pi",
      scope: "project",
      config: true,
      dryRun: true,
    },
  );
});

test("a bare command line asks for no agent at all, so the run can name them", () => {
  assert.equal(parseInitArgs([]).agent, undefined);
});

test("an unknown flag fails loudly instead of being swallowed", () => {
  assert.throws(
    () => parseInitArgs(["--agents", "pi"]),
    (error: unknown) => error instanceof Error && /unknown flag --agents/.test(error.message),
  );
});

test("a value flag with nothing to eat is refused at the flag", () => {
  assert.throws(
    () => parseInitArgs(["--agent", "--dry-run"]),
    (error: unknown) => error instanceof Error && /--agent needs a value/.test(error.message),
  );
  assert.throws(
    () => parseInitArgs(["--scope"]),
    (error: unknown) => error instanceof Error && /--scope needs a value/.test(error.message),
  );
});

test("a positional agent id is refused, pointing at --agent", () => {
  assert.throws(
    () => parseInitArgs(["codex"]),
    (error: unknown) =>
      error instanceof ReviewError &&
      error.code === "invalid_arguments" &&
      error.suggestions.some((line) => line.includes("--agent codex")),
  );
});
