import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mountStatusBanner } from "../../../src/browser/dom/status-mount.ts";
import type { SessionData } from "../../../src/browser/dom/session-api.ts";
import type { DiffFile } from "../../../src/diff-extract.ts";
import type { ConversationEntry, FeedbackPrompt } from "../../../src/session-store.ts";
import { FakeNode } from "./fake-panel-dom.ts";

/**
 * The banner's root, standing in for the one the server rendered. Only
 * `querySelector` is stubbed: one node in, markup out is the mount's whole browser contact.
 */
function stubDocument(t: TestContext): FakeNode {
  const root = new FakeNode("div", 'id="lsr-status-banner"');
  const globals = globalThis as Record<string, unknown>;
  const before = globals.document;
  globals.document = { querySelector: () => root };
  t.after(() => {
    globals.document = before;
  });
  return root;
}

function file(path: string): DiffFile {
  return {
    path,
    status: "modified",
    diff: `@@ -1 +1 @@\n-old\n+new ${path}`,
    insertions: 3,
    deletions: 1,
    oversized: false,
  };
}

function said(role: "reviewer" | "agent", comments: number): ConversationEntry {
  return {
    role,
    at: "2025-01-01T00:05:00.000Z",
    prompts: Array.from({ length: comments }, (_unused, index) => ({
      type: "message" as const,
      comment: `${role} ${index}`,
    })),
  };
}

function session(over: Partial<SessionData> = {}): SessionData {
  const base: SessionData = {
    intents: [],
    commits: [],
    groups: [{ name: "Schema", rationale: "why", files: [file("src/db.ts")] }],
    approved: [],
    approval: {},
    conversation: [said("reviewer", 2)],
    rounds: [{ index: 0, at: "2025-01-01T00:00:00.000Z" }],
    pending: [],
    status: "open",
  };
  return Object.assign(base, over);
}

/** The count the card printed against a label, e.g. `comments sent`. */
function figure(html: string, label: string): string | undefined {
  const found = new RegExp(
    `lsr-closing-count">([^<]+)</span><span class="lsr-closing-label">${label}<`,
  ).exec(html);
  return found?.[1];
}

test("the presence frame decides which of the three the banner says", (t) => {
  const root = stubDocument(t);
  const banner = mountStatusBanner(session());

  banner.setPresence({ waiting: true, working: false });
  assert.match(root.innerHTML, /agent is waiting/i);

  banner.setPresence({ waiting: false, working: true });
  assert.match(root.innerHTML, /agent is working on your feedback/i);

  banner.setPresence({ waiting: false, working: false });
  assert.match(root.innerHTML, /no agent is waiting/i);
});

test("a session that ended draws the summary of what the fresh read says", (t) => {
  const root = stubDocument(t);
  const banner = mountStatusBanner(session());

  banner.setSession(
    session({
      status: "ended",
      endedBy: "reviewer",
      conversation: [said("reviewer", 2), said("agent", 1), said("reviewer", 1)],
    }),
  );

  assert.equal(figure(root.innerHTML, "comments sent"), "3");
  assert.equal(figure(root.innerHTML, "agent reply"), "1");
  assert.match(root.innerHTML, /You ended this review\./);
});

test("a repeated session event leaves the summary the reviewer is reading alone", (t) => {
  // Every stream event refetches the session; redrawing the scrollable card
  // would throw the reviewer back to the top of a summary they were halfway down.
  const root = stubDocument(t);
  const banner = mountStatusBanner(session());
  banner.setSession(session({ status: "ended", endedBy: "reviewer" }));
  assert.match(root.innerHTML, /lsr-closing/, "the card should have been drawn to begin with");
  // A mark of the test's own, so a second write of identical markup shows up.
  root.innerHTML = "<p>touched</p>";

  banner.setSession(session({ status: "ended", endedBy: "reviewer" }));

  assert.equal(root.innerHTML, "<p>touched</p>", "the banner rewrote markup it had already drawn");
});

test("Send & End closes the review on what the page knows, before the server is asked", (t) => {
  const root = stubDocument(t);
  const banner = mountStatusBanner(session({ conversation: [] }));
  const sent: FeedbackPrompt[] = [
    { type: "message", comment: "one" },
    { type: "message", comment: "two" },
  ];

  banner.setEndedByReviewer(sent);

  assert.match(root.innerHTML, /You ended this review\./);
  assert.equal(figure(root.innerHTML, "comments sent"), "2");
});

test("an end that carried no words counts none, and says none were delivered", (t) => {
  const root = stubDocument(t);
  const banner = mountStatusBanner(session({ conversation: [] }));

  banner.setEndedByReviewer([]);

  assert.equal(figure(root.innerHTML, "comments sent"), undefined);
  assert.doesNotMatch(root.innerHTML, /has left this page/);
  assert.match(root.innerHTML, /You ended this review\./);
});
