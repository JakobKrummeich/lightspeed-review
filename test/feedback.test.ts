import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closedBy,
  drainPending,
  parseFeedbackRequest,
  withAgentReply,
  withFeedback,
} from "../src/feedback.ts";
import type { DiffGroup } from "../src/diff-extract.ts";
import type { SessionRecord } from "../src/session-store.ts";

/** Two groups that share a file, so the total counts distinct paths and not rows. */
function groups(): DiffGroup[] {
  const file = (path: string) => ({
    path,
    status: "modified" as const,
    diff: "",
    insertions: 1,
    deletions: 0,
    oversized: false,
  });
  return [
    { name: "API", rationale: "why", files: [file("a.ts"), file("shared.ts")] },
    { name: "Tests", rationale: "why", files: [file("shared.ts"), file("b.ts")] },
  ];
}

/** The same two, with the trailing one tiered `sweep`: a lane the review
 *  offered to approve unread. `shared.ts` sits in both. */
function tieredGroups(): DiffGroup[] {
  const [study, bulk] = groups();
  return [
    { ...study!, tier: "study" },
    { ...bulk!, tier: "sweep" },
  ];
}

function session(rounds: number): SessionRecord {
  return {
    key: "k",
    repoRoot: "/repo",
    branch: "work",
    base: "main",
    status: "open",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    groups: [],
    conversation: [],
    pending: [],
    approved: [],
    rounds: Array.from({ length: rounds }, (_, index) => ({
      index,
      at: `2025-01-0${index + 1}T00:00:00.000Z`,
      files: [],
      approvedAtEnd: [],
    })),
  };
}

const annotation = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "annotation",
  file: "a.ts",
  group: "API",
  selected_text: "+x",
  comment: "why?",
  ...extra,
});

const request = (prompt: unknown): unknown => ({ prompts: [prompt], ended: false });

test("a well-formed annotation without anchors parses and stays anchorless", () => {
  const parsed = parseFeedbackRequest(request(annotation()));

  assert.deepEqual(parsed?.prompts, [
    { type: "annotation", file: "a.ts", group: "API", selected_text: "+x", comment: "why?" },
  ]);
});

test("a message prompt parses", () => {
  const parsed = parseFeedbackRequest(request({ type: "message", comment: "looks good" }));

  assert.deepEqual(parsed, { prompts: [{ type: "message", comment: "looks good" }], ended: false });
});

test("anchors are carried through when the triple is complete", () => {
  const parsed = parseFeedbackRequest(
    request(annotation({ line_start: 12, line_end: 14, side: "old" })),
  );

  assert.deepEqual(parsed?.prompts[0], {
    type: "annotation",
    file: "a.ts",
    group: "API",
    selected_text: "+x",
    comment: "why?",
    line_start: 12,
    line_end: 14,
    side: "old",
  });
});

test("columns are carried through, so the agent knows which characters were marked", () => {
  const parsed = parseFeedbackRequest(
    request(annotation({ line_start: 12, line_end: 12, side: "new", col_start: 14, col_end: 26 })),
  );

  assert.deepEqual(parsed?.prompts[0], {
    type: "annotation",
    file: "a.ts",
    group: "API",
    selected_text: "+x",
    comment: "why?",
    line_start: 12,
    line_end: 12,
    side: "new",
    col_start: 14,
    col_end: 26,
  });
});

test("one column without the other stands: only that end of the selection is clipped", () => {
  const parsed = parseFeedbackRequest(
    request(annotation({ line_start: 12, line_end: 14, side: "new", col_start: 5 })),
  );

  assert.equal(parsed?.prompts[0]?.type === "annotation" && parsed.prompts[0].col_start, 5);
  assert.equal("col_end" in (parsed?.prompts[0] ?? {}), false);
});

test("columns alone are an attempted anchor, so a missing line range is still rejected", () => {
  assert.equal(parseFeedbackRequest(request(annotation({ col_start: 5 }))), undefined);
});

test("columns must be whole positive numbers, and must not run backwards in one line", () => {
  const bad = [
    { col_start: 0 },
    { col_start: 1.5 },
    { col_end: "3" },
    { col_end: Number.NaN },
    // Only within a single line: on a range of lines the columns sit on
    // different lines, so a larger start column is ordinary.
    { col_start: 9, col_end: 4 },
  ];

  for (const columns of bad) {
    assert.equal(
      parseFeedbackRequest(
        request(annotation({ line_start: 12, line_end: 12, side: "new", ...columns })),
      ),
      undefined,
      JSON.stringify(columns),
    );
  }
});

test("a start column past the end column is fine across lines: they are different lines", () => {
  const parsed = parseFeedbackRequest(
    request(annotation({ line_start: 12, line_end: 14, side: "new", col_start: 9, col_end: 4 })),
  );

  assert.equal(parsed?.prompts.length, 1);
});

test("a half-written anchor is rejected: a range without a side cannot be sliced", () => {
  assert.equal(parseFeedbackRequest(request(annotation({ line_start: 12 }))), undefined);
  assert.equal(
    parseFeedbackRequest(request(annotation({ line_start: 12, line_end: 14 }))),
    undefined,
  );
  assert.equal(parseFeedbackRequest(request(annotation({ side: "new" }))), undefined);
});

test("an unknown side is rejected", () => {
  assert.equal(
    parseFeedbackRequest(request(annotation({ line_start: 1, line_end: 2, side: "both" }))),
    undefined,
  );
});

test("line numbers must be whole positive numbers in order", () => {
  const bad = [
    { line_start: 0, line_end: 2, side: "new" },
    { line_start: 1.5, line_end: 2, side: "new" },
    { line_start: 5, line_end: 2, side: "new" },
    { line_start: "1", line_end: 2, side: "new" },
    { line_start: 1, line_end: Number.NaN, side: "new" },
  ];

  for (const anchor of bad) {
    assert.equal(
      parseFeedbackRequest(request(annotation(anchor))),
      undefined,
      JSON.stringify(anchor),
    );
  }
});

test("feedback is stamped with the round it was sent in", () => {
  const updated = withFeedback(
    session(3),
    { prompts: [{ type: "message", comment: "still leaks" }], ended: false },
    "2025-01-03T01:00:00.000Z",
  );

  assert.equal(updated.conversation.at(-1)?.roundIndex, 2);
});

test("an agent's summary is stamped with the round it opened, not the one it answers", () => {
  // Workflow is fix, `start`, then `poll --agent-reply`: the summary lands after its round is
  // open, and stamping the on-screen round puts it under that round's own line.
  const answered = withFeedback(
    session(1),
    { prompts: [{ type: "message", comment: "still leaks" }], ended: false },
    "2025-01-01T01:00:00.000Z",
  );
  const reopened = { ...answered, rounds: session(2).rounds };

  const replied = withAgentReply(reopened, "fixed, and split the helper out", "2025-01-02T01:00Z");

  assert.deepEqual(
    replied.conversation.map((entry) => entry.roundIndex),
    [0, 1],
  );
});

test("a session with no rounds stamps nothing rather than inventing a round", () => {
  const updated = withAgentReply(session(0), "fixed", "2025-01-02T01:00:00.000Z");

  assert.equal("roundIndex" in (updated.conversation.at(-1) ?? {}), false);
});

test("an end from the browser is recorded as the reviewer's", () => {
  const updated = withFeedback(
    session(1),
    { prompts: [], ended: true },
    "2025-01-02T00:00:00.000Z",
  );

  assert.equal(updated.status, "ended");
  assert.equal(updated.endedBy, "reviewer");
});

test("the first close is the one that ended the review, whichever party it was", () => {
  const open = session(1);

  assert.deepEqual(closedBy(open, "reviewer"), { endedBy: "reviewer" });
  assert.deepEqual(closedBy(open, "agent"), { endedBy: "agent" });
  // Already ended: a second close decided nothing, so it writes nothing — and
  // a session ended before closers were recorded stays unattributed.
  assert.deepEqual(closedBy({ ...open, status: "ended", endedBy: "agent" }, "reviewer"), {});
  assert.deepEqual(closedBy({ ...open, status: "ended" }, "agent"), {});
});

test("a second `Send & End` leaves the first closer standing", () => {
  const ended: SessionRecord = { ...session(1), status: "ended", endedBy: "agent" };

  const again = withFeedback(ended, { prompts: [], ended: true }, "2025-01-03T00:00:00.000Z");

  assert.equal(again.endedBy, "agent");
});

test("feedback that does not end the review records no closer", () => {
  const updated = withFeedback(
    session(1),
    { prompts: [{ type: "message", comment: "more" }], ended: false },
    "2025-01-02T00:00:00.000Z",
  );

  assert.equal("endedBy" in updated, false);
});

test("an ended poll carries what was approved, counted over distinct paths", () => {
  const ended: SessionRecord = {
    ...session(1),
    status: "ended",
    endedBy: "reviewer",
    groups: groups(),
    approved: ["shared.ts", "a.ts"],
  };

  const drained = drainPending(ended);

  assert.deepEqual(drained?.payload.approval, {
    verdict: "partial",
    approved: 2,
    unapproved: 1,
    swept: 0,
    total: 3,
  });
  assert.equal(drained?.payload.endedBy, "reviewer");
});

test("every file approved is the one verdict that reads as a sign-off", () => {
  const ended: SessionRecord = {
    ...session(1),
    status: "ended",
    groups: groups(),
    approved: ["a.ts", "shared.ts", "b.ts"],
  };

  assert.deepEqual(drainPending(ended)?.payload.approval, {
    verdict: "signed-off",
    approved: 3,
    unapproved: 0,
    swept: 0,
    total: 3,
  });
});

test("a review ended holding no files is empty, which is not a sign-off", () => {
  const ended: SessionRecord = { ...session(1), status: "ended", groups: [] };

  assert.deepEqual(drainPending(ended)?.payload.approval, {
    verdict: "empty",
    approved: 0,
    unapproved: 0,
    swept: 0,
    total: 0,
  });
});

test("an approval taken in a sweep lane is reported as approved and unread", () => {
  const ended: SessionRecord = {
    ...session(1),
    status: "ended",
    groups: tieredGroups(),
    approved: ["a.ts", "shared.ts", "b.ts"],
  };

  // `shared.ts` is not swept: the study chapter put it in front of the reviewer.
  assert.deepEqual(drainPending(ended)?.payload.approval, {
    verdict: "signed-off",
    approved: 3,
    unapproved: 0,
    swept: 1,
    total: 3,
  });
});

test("a sweep lane nobody ticked is swept nowhere: it is only unapproved", () => {
  const ended: SessionRecord = {
    ...session(1),
    status: "ended",
    groups: tieredGroups(),
    approved: ["a.ts"],
  };

  assert.deepEqual(drainPending(ended)?.payload.approval, {
    verdict: "partial",
    approved: 1,
    unapproved: 2,
    swept: 0,
    total: 3,
  });
});

test("an approval for a path the grouping dropped is not counted", () => {
  const ended: SessionRecord = {
    ...session(1),
    status: "ended",
    groups: groups(),
    approved: ["a.ts", "gone.ts"],
  };

  assert.deepEqual(drainPending(ended)?.payload.approval, {
    verdict: "partial",
    approved: 1,
    unapproved: 2,
    swept: 0,
    total: 3,
  });
});

test("an open poll carries no approval evidence: the review is not over", () => {
  const open: SessionRecord = {
    ...session(1),
    status: "feedback",
    groups: groups(),
    approved: ["a.ts"],
    pending: [{ type: "message", comment: "look again" }],
  };

  assert.equal("approval" in (drainPending(open)?.payload ?? {}), false);
});

test("a malformed payload is rejected", () => {
  assert.equal(parseFeedbackRequest(undefined), undefined);
  assert.equal(parseFeedbackRequest({ prompts: [], ended: "yes" }), undefined);
  assert.equal(parseFeedbackRequest({ prompts: {}, ended: false }), undefined);
  assert.equal(parseFeedbackRequest(request({ type: "annotation", comment: "x" })), undefined);
  assert.equal(parseFeedbackRequest(request({ type: "other", comment: "x" })), undefined);
});
