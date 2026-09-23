import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusBanner, type StatusState } from "../../src/browser/status-banner.ts";
import type { ClosedReview } from "../../src/browser/closing-summary.ts";
import type { Turn } from "../../src/session-store.ts";

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

const REVIEWERS: Turn = { holder: "reviewer", at: "2025-01-01T00:00:00.000Z" };
const READING: Turn = { holder: "agent", mode: "reading", at: "2025-01-01T00:06:00.000Z" };

function banner(over: Partial<StatusState> = {}): StatusState {
  return { status: "open", agentWaiting: false, turn: REVIEWERS, review, ...over };
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

test("says the agent has the feedback once the turn is the agent's", () => {
  const html = renderStatusBanner(banner({ turn: READING }));

  assert.match(html, /data-turn="agent"/);
  assert.match(html, /the agent has your feedback/i);
  assert.doesNotMatch(html, /no agent is waiting/i);
});

/** `work "<plan>"` is the agent buying silence with a reason. The banner is
 * where that reason is spent: a reviewer watching a still page wants to know
 * what is being done, not merely that something is. */
test("a declared plan is named in the banner instead of the general sentence", () => {
  const html = renderStatusBanner(
    banner({
      turn: {
        holder: "agent",
        mode: "working",
        at: "2025-01-01T00:07:00.000Z",
        note: "splitting the helper out",
      },
    }),
  );

  assert.match(html, /implementing: splitting the helper out/);
  assert.doesNotMatch(html, /has your feedback/);
});

test("work with no plan still says which of the two silences it is", () => {
  const html = renderStatusBanner(
    banner({ turn: { holder: "agent", mode: "working", at: "2025-01-01T00:07:00.000Z" } }),
  );

  assert.match(html, /the agent is implementing your feedback/i);
});

test("a plan cannot inject markup into the header", () => {
  const html = renderStatusBanner(
    banner({
      turn: {
        holder: "agent",
        mode: "working",
        at: "2025-01-01T00:07:00.000Z",
        note: "<script>alert(1)</script>",
      },
    }),
  );

  // Case-insensitive and open-ended: a regexp that only knows the exact lower-case
  // tag would pass while the banner served `<SCRIPT>` or `<script src=x>`.
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
});

test("the turn beats waiting, since what became of the feedback is the news", () => {
  // A second agent parked on the wait while the first is off working says
  // nothing the reviewer can act on; what became of their feedback does.
  const html = renderStatusBanner(banner({ agentWaiting: true, turn: READING }));

  assert.match(html, /the agent has your feedback/i);
  assert.doesNotMatch(html, /agent is waiting/i);
});

test("does not claim an agent is working on an ended review", () => {
  const html = renderStatusBanner(banner({ status: "ended", turn: READING }));

  assert.doesNotMatch(html, /agent is working/i);
  assert.doesNotMatch(html, /has your feedback/i);
});
