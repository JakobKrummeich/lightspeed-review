import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffFile, DiffGroup } from "../../src/diff-extract.ts";
import type { ConversationEntry } from "../../src/session-store.ts";
import {
  closingSummary,
  renderClosingSummary,
  type ClosedReview,
} from "../../src/browser/closing-summary.ts";

function file(path: string, insertions = 3, deletions = 1): DiffFile {
  return {
    path,
    status: "modified",
    diff: `@@ -1 +1 @@\n-old\n+new ${path}`,
    insertions,
    deletions,
    oversized: false,
  };
}

function group(name: string, files: DiffFile[]): DiffGroup {
  return { name, rationale: `why ${name}`, files };
}

function said(role: "reviewer" | "agent", comments: number): ConversationEntry {
  return {
    role,
    at: "2024-05-01T10:00:00.000Z",
    prompts: Array.from({ length: comments }, (_unused, index) => ({
      type: "message" as const,
      comment: `${role} ${index}`,
    })),
  };
}

const review: ClosedReview = {
  groups: [
    group("Schema", [file("prisma/schema.prisma", 10, 2), file("src/db.ts", 4, 0)]),
    group("API", [file("src/api/users.ts", 7, 5)]),
  ],
  conversation: [said("reviewer", 2), said("agent", 1), said("reviewer", 1)],
  rounds: [
    { index: 0, at: "2024-05-01T09:00:00.000Z" },
    { index: 1, at: "2024-05-01T11:00:00.000Z" },
  ],
  approved: ["src/db.ts"],
  endedBy: "reviewer",
};

function figure(summary: ReturnType<typeof closingSummary>, label: RegExp): number | undefined {
  return summary.figures.find((entry) => label.test(entry.label))?.count;
}

test("counts the rounds, groups, files and lines the review was made of", () => {
  const summary = closingSummary(review);

  assert.equal(figure(summary, /^rounds?$/), 2);
  assert.equal(figure(summary, /^groups?$/), 2);
  assert.equal(figure(summary, /^files?$/), 3);
  assert.equal(figure(summary, /^lines? changed$/), 28);
});

test("counts a file once however many groups list it", () => {
  const shared = file("src/db.ts", 4, 0);
  const summary = closingSummary({
    ...review,
    groups: [group("Schema", [shared]), group("API", [shared])],
  });

  assert.equal(figure(summary, /^files?$/), 1);
  assert.equal(figure(summary, /^lines? changed$/), 4);
});

test("counts what was said on each side, comment by comment rather than turn by turn", () => {
  const summary = closingSummary(review);

  assert.equal(figure(summary, /^comments? sent$/), 3);
  assert.equal(figure(summary, /^agent (reply|replies)$/), 1);
});

test("leaves out a side of the conversation that never spoke, rather than printing a zero", () => {
  const summary = closingSummary({ ...review, conversation: [] });

  assert.equal(figure(summary, /^comments? sent$/), undefined);
  assert.equal(figure(summary, /^agent (reply|replies)$/), undefined);
  assert.deepEqual(
    summary.figures.map((entry) => entry.label),
    ["rounds", "groups", "files", "lines changed"],
  );
});

test("names each figure in the singular when there is one of it", () => {
  const summary = closingSummary({
    ...review,
    groups: [group("Only", [file("src/db.ts", 1, 0)])],
    conversation: [said("reviewer", 1), said("agent", 1)],
    rounds: [{ index: 0, at: "2024-05-01T09:00:00.000Z" }],
  });

  assert.deepEqual(
    summary.figures.map((entry) => `${entry.count} ${entry.label}`),
    ["1 round", "1 group", "1 file", "1 line changed", "1 comment sent", "1 agent reply"],
  );
});

test("groups the digits of a long count, so its weight is read rather than counted", () => {
  const big = { ...review, groups: [group("Big", [file("src/db.ts", 1200, 4)])] };

  assert.equal(figure(closingSummary(big), /^lines? changed$/), 1204);
  assert.match(renderClosingSummary(big), />1,204</);
});

test("says how much was approved, in the same terms the agent is told", () => {
  assert.equal(closingSummary(review).verdict, "1 of 3 files approved.");
  assert.equal(
    closingSummary({
      ...review,
      approved: ["prisma/schema.prisma", "src/db.ts", "src/api/users.ts"],
    }).verdict,
    "All 3 files approved.",
  );
  assert.equal(closingSummary({ ...review, approved: [] }).verdict, "No files approved.");
});

test("one file short of the lot is a fraction, never 'all'", () => {
  // The off-by-one the word `All` would hide: the reviewer left one file
  // unticked on purpose, and the card must not round that away.
  const summary = closingSummary({ ...review, approved: ["src/db.ts", "src/api/users.ts"] });

  assert.equal(summary.verdict, "2 of 3 files approved.");
});

test("a tick on a file this review does not hold cannot inflate the count", () => {
  // `approved` outlives a regrouping: paths ticked in an earlier round stay in
  // the list. Counted over that list, a one-file review would claim three.
  const summary = closingSummary({
    ...review,
    groups: [group("Only", [file("src/db.ts", 4, 0)])],
    approved: ["src/db.ts", "gone/one.ts", "gone/two.ts"],
  });

  assert.equal(summary.verdict, "All 1 file approved.");
});

test("a review with nothing in it claims nothing was approved of nothing", () => {
  const summary = closingSummary({ ...review, groups: [], approved: [] });

  assert.equal(summary.verdict, "There was nothing here to approve.");
  assert.deepEqual(summary.figures, [], "an empty review is a list of things nobody did");
});

test("an empty review renders the verdict alone, with no list to rule off", () => {
  const html = renderClosingSummary({ ...review, groups: [], approved: [] });

  assert.doesNotMatch(html, /<ul/);
  assert.match(html, /There was nothing here to approve\./);
});

test("names who ended the review, and says nothing of either party when the record does not", () => {
  assert.match(closingSummary(review).note, /^You ended this review\./);
  assert.match(
    closingSummary({ ...review, endedBy: "agent" }).note,
    /^The agent ended this review\./,
  );
  assert.match(closingSummary({ ...review, endedBy: undefined }).note, /^This review is ended\./);
});

test("tells the reviewer nothing they wrote is left behind, only when they wrote some", () => {
  // Deliberately not "gone to the agent": prompts sent with the last press may
  // still be queued with nobody polling — the page must not claim delivery.
  assert.match(closingSummary(review).note, /has left this page/);
  assert.doesNotMatch(closingSummary({ ...review, conversation: [] }).note, /has left this page/);
  assert.doesNotMatch(closingSummary(review).note, /gone to the agent/);
  assert.match(closingSummary({ ...review, conversation: [] }).note, /close this tab/);
});

test("renders the verdict as the heading, with the figures under it", () => {
  const html = renderClosingSummary(review);

  assert.match(html, /<h2 class="lsr-closing-verdict">1 of 3 files approved\.<\/h2>/);
  assert.match(html, /lsr-closing-count">2<\/span><span class="lsr-closing-label">rounds/);
  assert.match(html, /lsr-closing-note">You ended this review\./);
});

test("keeps its own celebration out of it: no exclamation, no emoji", () => {
  const html = renderClosingSummary(review);

  assert.doesNotMatch(html, /!/);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
});
