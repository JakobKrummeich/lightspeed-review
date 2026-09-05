import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusBanner, type StatusState } from "../../src/browser/status-banner.ts";
import type { ClosedReview } from "../../src/browser/closing-summary.ts";

const review: ClosedReview = {
  groups: [
    {
      name: "Auth",
      rationale: "why auth",
      files: [
        {
          path: "src/auth.ts",
          status: "modified",
          diff: "",
          insertions: 4,
          deletions: 1,
          oversized: false,
        },
      ],
    },
  ],
  conversation: [],
  rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z" }],
  approved: ["src/auth.ts"],
  endedBy: "reviewer",
};

/** An open review nobody is doing anything about, unless the case says so. */
function banner(over: Partial<StatusState> = {}): StatusState {
  return { status: "open", agentWaiting: false, agentWorking: false, review, ...over };
}

test("shows the session status", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.match(html, /data-status="open"/);
  assert.match(html, />open</);
});

test("says the agent is waiting while it polls", () => {
  const html = renderStatusBanner(banner({ agentWaiting: true }));

  assert.match(html, /data-waiting="true"/);
  assert.match(html, /agent is waiting/i);
});

test("says nobody is waiting when no agent polls, rather than hiding the fact", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.match(html, /data-waiting="false"/);
  assert.match(html, /no agent is waiting/i);
});

test("covers the page with what the review came to once it is closed", () => {
  const html = renderStatusBanner(banner({ status: "ended" }));

  assert.match(html, /lsr-ended-overlay/);
  assert.match(html, /All 1 file approved\./);
  assert.match(html, /You ended this review\./);
  // The reviewer never touches the CLI, so no command is suggested to them.
  assert.doesNotMatch(html, /lightspeed/);
});

test("shows no overlay while the review is still open", () => {
  const html = renderStatusBanner(banner({ agentWaiting: false }));

  assert.doesNotMatch(html, /lsr-ended-overlay/);
});

test("does not claim an agent is waiting on an ended review", () => {
  const html = renderStatusBanner(banner({ status: "ended", agentWaiting: true }));

  assert.doesNotMatch(html, /agent is waiting/i);
});

test("says the agent is working once it has taken the feedback away", () => {
  const html = renderStatusBanner(banner({ agentWorking: true }));

  assert.match(html, /data-working="true"/);
  assert.match(html, /agent is working on your feedback/i);
  assert.doesNotMatch(html, /no agent is waiting/i);
});

test("working beats waiting, since work is the more particular news", () => {
  // A second agent parked on the poll while the first is off working says
  // nothing the reviewer can act on; what became of their feedback does.
  const html = renderStatusBanner(banner({ agentWaiting: true, agentWorking: true }));

  assert.match(html, /agent is working on your feedback/i);
  assert.doesNotMatch(html, /agent is waiting/i);
});

test("does not claim an agent is working on an ended review", () => {
  const html = renderStatusBanner(banner({ status: "ended", agentWorking: true }));

  assert.doesNotMatch(html, /agent is working/i);
});
