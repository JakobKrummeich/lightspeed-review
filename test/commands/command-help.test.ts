import { test } from "node:test";
import assert from "node:assert/strict";
import { commandHelp, commandSummary } from "../../src/commands/command-help.ts";

test("every command the CLI registers has help", () => {
  const commands = [
    "open",
    "reply",
    "work",
    "publish",
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

/** The three verbs that hand the turn back all wait, and all say so the same way. */
test("every waiting verb's help says to run it in the foreground and re-run it if killed", () => {
  for (const verb of ["open", "reply", "publish"]) {
    const help = commandHelp(verb) ?? "";
    assert.match(help, /foreground/, verb);
    assert.match(help, /never under a timeout/, verb);
    assert.match(help, /re-run the same command/, verb);
  }
});

/** The verbs are only usable if their help states where the turn lands, since
 * that is what decides which command is legal next. */
test("every turn verb's help names what it does to the turn", () => {
  assert.match(commandHelp("open") ?? "", /^turn: .*then yours \(digesting\)/m);
  assert.match(commandHelp("reply") ?? "", /^turn: .*The reviewer's afterwards/m);
  assert.match(commandHelp("work") ?? "", /^turn: .*yours \(working\) after/m);
  assert.match(commandHelp("publish") ?? "", /^turn: "?working before, the reviewer's after/m);
});

/** Two examples each: one plain, one with the flag that command exists for. */
test("every turn verb's help shows two examples", () => {
  for (const verb of ["open", "reply", "work", "publish"]) {
    assert.match(commandHelp(verb) ?? "", /^examples\[2\]:/m, verb);
  }
});

/** 2.x verbs are answered by the CLI, not by help: they have none. */
test("the removed verbs have no help entry", () => {
  for (const verb of ["start", "wait", "ask", "say"]) assert.equal(commandHelp(verb), undefined);
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

test("open help lists its flags", () => {
  const help = commandHelp("open") ?? "";

  assert.match(help, /--no-open/);
  assert.match(help, /--reopen/);
  assert.match(help, /--base/);
  assert.match(help, /--model/);
  assert.match(help, /--intent/);
});

test("reply and publish help show --to taking an item id and its text", () => {
  assert.match(commandHelp("reply") ?? "", /--to <id> '<text>'/);
  assert.match(commandHelp("publish") ?? "", /--to <id> '<text>'/);
  assert.match(commandHelp("reply") ?? "", /`main` for the main\s+chat/);
});
