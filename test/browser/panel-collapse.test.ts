import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSpokeAgain, railBadge, railLabel } from "../../src/browser/panel-collapse.ts";
import type { ConversationEntry } from "../../src/session-store.ts";

function entry(role: ConversationEntry["role"], comment: string): ConversationEntry {
  return { role, at: "2025-01-01T00:00:00.000Z", prompts: [{ type: "message", comment }] };
}

test("the rail says what it is, and what the shut panel is holding", () => {
  assert.equal(railLabel({ collapsed: false, queued: 0 }), "Hide the conversation");
  // Queued feedback is the one thing the reviewer cannot see once it is shut.
  assert.equal(railLabel({ collapsed: true, queued: 0 }), "Show the conversation");
  assert.equal(railLabel({ collapsed: true, queued: 2 }), "Show the conversation — 2 queued");
});

test("the badge is only ever on a shut panel that is hiding something", () => {
  assert.equal(railBadge({ collapsed: true, queued: 3 }), "3");
  assert.equal(railBadge({ collapsed: true, queued: 0 }), "");
  // Open, the pills themselves are the count.
  assert.equal(railBadge({ collapsed: false, queued: 3 }), "");
});

test("a shut panel opens for the agent, and for nobody else", () => {
  const asked = [entry("reviewer", "why is this a map?")];
  const answered = [...asked, entry("agent", "because the keys are file paths")];

  assert.equal(agentSpokeAgain(asked, answered), true);
  // The reviewer's own send comes back over SSE; springing the panel open at
  // that moment would fight the person who just sent it.
  assert.equal(agentSpokeAgain([], asked), false);
  // A re-group redraws the same conversation: nothing new was said.
  assert.equal(agentSpokeAgain(answered, answered), false);
  assert.equal(agentSpokeAgain(answered, []), false);
});
