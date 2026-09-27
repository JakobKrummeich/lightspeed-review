import { test } from "node:test";
import assert from "node:assert/strict";
import { arrivesByJump } from "../../src/browser/round-arrival.ts";
import { replayData, type ReadBetween } from "../../src/rounds/replay.ts";
import type {
  AnnotationPrompt,
  ConversationEntry,
  SessionRecord,
  SessionRound,
} from "../../src/session-store.ts";

/**
 * The page decides to jump before it has the replay, from the session alone;
 * the server decides what the replay holds. A jump with no replay under it, or
 * a replay that opens with no jump, is the two disagreeing — so over the same
 * sessions, a live round never replayed here jumps exactly when its replay has
 * cards.
 */

function round(index: number): SessionRound {
  return {
    index,
    at: `2024-01-0${index + 1}T00:00:00.000Z`,
    headCommit: String(index).repeat(40),
    files: [{ path: "src/a.ts", status: "modified", blob: `blob-${index}` }],
    approvedAtEnd: [],
  };
}

const annotation: AnnotationPrompt = {
  type: "annotation",
  id: "evt-1",
  file: "src/a.ts",
  group: "Core",
  selected_text: "old line",
  comment: "why is this here?",
  side: "new",
  line_start: 1,
  line_end: 1,
};

function said(
  roundIndex: number | undefined,
  prompts: ConversationEntry["prompts"],
  role: ConversationEntry["role"] = "reviewer",
): ConversationEntry {
  // No index: an entry from before rounds were stamped, placed by its time.
  const at = `2024-01-0${(roundIndex ?? 0) + 1}T12:00:00.000Z`;
  return roundIndex === undefined ? { role, at, prompts } : { role, at, roundIndex, prompts };
}

const message = { type: "message", comment: "looks fine" } as const;
const reply = { type: "reply", thread: "evt-1", comment: "renamed it" } as const;

const FIXTURES: { name: string; rounds: number; conversation: ConversationEntry[] }[] = [
  { name: "a first round", rounds: 1, conversation: [said(0, [annotation])] },
  { name: "last round commented on", rounds: 2, conversation: [said(0, [annotation])] },
  { name: "a general message only", rounds: 2, conversation: [said(0, [message])] },
  { name: "nothing said", rounds: 2, conversation: [] },
  { name: "comments in this round only", rounds: 2, conversation: [said(1, [annotation])] },
  { name: "comments two rounds back", rounds: 3, conversation: [said(0, [annotation])] },
  { name: "comments on the round before", rounds: 3, conversation: [said(1, [annotation])] },
  { name: "an unstamped comment", rounds: 2, conversation: [said(undefined, [annotation])] },
  {
    name: "the agent's words only",
    rounds: 2,
    conversation: [said(0, [reply], "agent"), said(0, [message])],
  },
  {
    name: "a message beside a comment",
    rounds: 2,
    conversation: [said(0, [message, annotation]), said(1, [reply], "agent")],
  },
];

const patchless: ReadBetween = () => ({ state: "patch", patch: "" });

for (const fixture of FIXTURES) {
  test(`${fixture.name}: the page jumps exactly when the replay has cards`, () => {
    const rounds = Array.from({ length: fixture.rounds }, (_, index) => round(index));
    const record = {
      status: "open",
      rounds,
      conversation: fixture.conversation,
    } as unknown as SessionRecord;

    const cards = replayData(record, patchless, () => undefined).comments.length;
    const jumps = arrivesByJump(
      { rounds, conversation: fixture.conversation, status: "open" },
      undefined,
    );

    assert.equal(jumps, cards > 0);
  });
}

test("the fixtures cover both answers", () => {
  const answers = FIXTURES.map((fixture) =>
    arrivesByJump(
      {
        rounds: Array.from({ length: fixture.rounds }, (_, index) => round(index)),
        conversation: fixture.conversation,
        status: "open",
      },
      undefined,
    ),
  );

  assert.ok(answers.includes(true) && answers.includes(false));
});
