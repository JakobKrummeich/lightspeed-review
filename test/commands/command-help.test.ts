import { test } from "node:test";
import assert from "node:assert/strict";
import { commandHelp, commandSummary } from "../../src/commands/command-help.ts";

test("every command the CLI registers has help", () => {
  const commands = [
    "start",
    "poll",
    "approvals",
    "end",
    "serve",
    "stop",
    "feedback",
    "login",
    "logout",
    "init",
    "skill",
  ];
  for (const command of commands) {
    assert.match(commandHelp(command) ?? "", new RegExp(`^command: ${command}$`, "m"), command);
  }
});

test("an unregistered command has no help, so the CLI can fall through", () => {
  assert.equal(commandHelp("nonsense"), undefined);
});

test("the summary of a command is the first line of its own help", () => {
  assert.equal(
    commandSummary("stop"),
    "Shut the background review server down; sessions stay on disk",
  );
  assert.match(commandSummary("login"), /agent must never run it/);
});

/** Top-level help lists what the CLI registers, so a command with no help entry
 * still has to render as a line an agent can act on. */
test("a command without a help entry is summarised as its own --help", () => {
  assert.equal(commandSummary("nonsense"), "Run `lightspeed nonsense --help`");
});

test("poll help repeats that it blocks in the foreground", () => {
  const help = commandHelp("poll") ?? "";

  assert.match(help, /foreground/);
  assert.match(help, /never background it or wrap it in a timeout/);
});

test("feedback help documents every subcommand and the list flags", () => {
  const help = commandHelp("feedback") ?? "";

  assert.match(help, /feedback list/);
  assert.match(help, /feedback show/);
  assert.match(help, /feedback prune/);
  assert.match(help, /--format/);
  assert.match(help, /--with-patches/);
});

test("login help says it is human-run and names the providers", () => {
  const help = commandHelp("login") ?? "";

  assert.match(help, /agent must never run it/);
  assert.match(help, /anthropic, openai-codex, github-copilot/);
});

test("init help names the real destinations and the restart nobody documented", () => {
  const help = commandHelp("init") ?? "";

  assert.match(help, /~\/\.pi\/agent\/skills\/lightspeed\/SKILL\.md/);
  assert.doesNotMatch(help, /~\/\.pi\/skills/);
  assert.match(help, /~\/\.config\/opencode\/AGENTS\.md/);
  assert.match(help, /copilot-instructions\.md/);
  assert.match(help, /it has no machine-wide file/);
  assert.match(help, /\/reload/);
  assert.match(help, /--dry-run/);
  assert.match(help, /^examples\[\d+\]:.*lightspeed init --config/m);
});

/** The path that made the whole hand-redirect story fail silently. */
test("skill help no longer names a pi directory pi never reads", () => {
  const help = commandHelp("skill") ?? "";

  assert.match(help, /~\/\.pi\/agent\/skills\/lightspeed\/SKILL\.md/);
  assert.doesNotMatch(help, /~\/\.pi\/skills/);
  assert.match(help, /lightspeed init/);
});

test("skill help names every agent and where its file lives", () => {
  const help = commandHelp("skill") ?? "";

  assert.match(help, /pi, claude-code, codex, opencode, vscode/);
  assert.match(help, /\.claude\/skills\/lightspeed\/SKILL\.md/);
  assert.match(help, /AGENTS\.md/);
  assert.match(help, /copilot-instructions\.md/);
});

test("start help lists its flags", () => {
  const help = commandHelp("start") ?? "";

  assert.match(help, /--no-open/);
  assert.match(help, /--base/);
  assert.match(help, /--model/);
});
