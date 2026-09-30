import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffRenderer } from "../../src/browser/diff-renderer.ts";
import { agentMessages } from "../../src/browser/message-news.ts";
import {
  agentRoundReply,
  renderReplayOverlay,
  replayHasNews,
  type ReplayView,
} from "../../src/browser/round-replay.ts";
import type { ReplayComment, ReplayData } from "../../src/rounds/replay.ts";
import type { ConversationEntry, RoundMark } from "../../src/session-store.ts";

const renderer: DiffRenderer = { renderFile: (diff) => `<pre>${diff}</pre>` };

function comment(over: Partial<ReplayComment> = {}): ReplayComment {
  return {
    id: "c1",
    file: "src/api.ts",
    group: "API",
    anchor: { side: "new", line_start: 3, line_end: 4 },
    selected_text: "+const x = 1;",
    comment: "this name says nothing",
    status: "addressed",
    state: "ok",
    answers: [
      {
        file: "src/api.ts",
        hunks: [
          {
            header: "@@ -3,2 +3,2 @@",
            body: "-const x = 1;\n+const total = 1;",
            insertions: 1,
            deletions: 1,
          },
        ],
      },
    ],
    note: "renamed it to total",
    ...over,
  };
}

function render(over: Partial<ReplayView> & { data?: ReplayData } = {}): string {
  const view: ReplayView = {
    data: { comments: [comment()] },
    current: 0,
    seen: new Set(),
    ...over,
  };
  return renderReplayOverlay(view, renderer);
}

test("a card is the file, the verdict, the reviewer's words and the agent's answer", () => {
  const html = render();

  assert.match(html, /lsr-replay-path">src\/api\.ts</);
  assert.match(html, /lsr-replay-chip" data-status="addressed">addressed</);
  assert.match(html, /lsr-replay-selected">\+const x = 1;</);
  assert.match(html, /lsr-replay-comment">this name says nothing</);
  assert.match(html, /The agent's answer/);
  assert.match(html, /lsr-replay-note">renamed it to total</);
});

test("the hunks go through the diff renderer as the smallest patch it will take", () => {
  const html = render();

  assert.match(
    html,
    /<pre>--- a\/src\/api\.ts\n\+\+\+ b\/src\/api\.ts\n@@ -3,2 \+3,2 @@\n-const x = 1;\n\+const total = 1;<\/pre>/,
  );
  assert.match(html, /lsr-replay-answer-path"><code>src\/api\.ts<\/code>/);
  assert.match(html, /What changed/);
});

test("an answer set spanning files renders one labelled block per file", () => {
  const html = render({
    data: {
      comments: [
        comment({
          answers: [
            {
              file: "src/api.ts",
              hunks: [{ header: "@@ -1 +1 @@", body: "-a\n+b", insertions: 1, deletions: 1 }],
            },
            { file: "src/api.test.ts", hunks: [] },
          ],
        }),
      ],
    },
  });

  assert.match(html, /<code>src\/api\.ts<\/code>/);
  assert.match(html, /<code>src\/api\.test\.ts<\/code>/);
  assert.match(html, /No code change to show for this file\./);
});

test("an empty answer set is a fact, worded as decided and styled as nothing at all", () => {
  const html = render({ data: { comments: [comment({ answers: [], status: "unchanged" })] } });

  assert.match(html, /No code change — see the reply\./);
  assert.match(html, /data-status="unchanged">unchanged</);
  assert.doesNotMatch(html, /<pre>/, "there is no diff to draw");
  assert.doesNotMatch(html, /ignored/, "the word the spec barred");
  assert.doesNotMatch(html, /fail/i);
});

test("an oversized answer file says so instead of pretending nothing changed", () => {
  const html = render({
    data: {
      comments: [comment({ answers: [{ file: "src/api.ts", hunks: [], oversized: true }] })],
    },
  });

  assert.match(html, /too large to show here/);
  assert.doesNotMatch(html, /No code change/);
});

test("a comment the agent did not map is marked, and answered by the round reply as such", () => {
  const html = render({
    data: { comments: [comment({ note: undefined })] },
    roundReply: "Round summary: renamed things.",
  });

  assert.match(html, /lsr-replay-unmapped">agent did not map this</);
  assert.match(html, /The agent's round reply/);
  assert.match(html, /lsr-replay-note">Round summary: renamed things\.</);
  assert.doesNotMatch(html, /The agent's answer</);
});

test("rewritten history is a status-only card that says what a rebase did", () => {
  const html = render({
    data: {
      comments: [
        comment({ state: "unreachable", status: "unknown", answers: [], note: undefined }),
      ],
    },
    roundReply: "Round summary.",
  });

  assert.match(html, /History was rewritten/);
  assert.match(html, /data-status="unknown">unknown</);
  assert.match(html, /lsr-replay-comment">this name says nothing</, "the comment itself stays");
  assert.doesNotMatch(html, /What changed/);
  assert.doesNotMatch(html, /Round summary/, "status-only means no borrowed answer either");
});

test("the other unreadable states are status-only too, each named honestly", () => {
  const unrecorded = render({
    data: { comments: [comment({ state: "unrecorded", status: "unknown", answers: [] })] },
  });
  const oversize = render({
    data: { comments: [comment({ state: "oversize", answers: [] })] },
  });

  assert.match(unrecorded, /recorded no commits/);
  assert.match(unrecorded, /Nothing was rewritten/);
  assert.match(oversize, /too large to show here/);
  assert.doesNotMatch(unrecorded, /What changed/);
  assert.doesNotMatch(oversize, /What changed/);
});

test("a status the union does not know renders as unknown, never as markup", () => {
  const forged = '"><img src=x onerror=alert(1)>' as ReplayComment["status"];

  const html = render({ data: { comments: [comment({ status: forged })] } });

  assert.match(html, /data-status="unknown">unknown</);
  assert.doesNotMatch(html, /onerror/, "the served string never reaches the page");
});

test("a state the union does not know is status-only with a plain sentence", () => {
  const forged = '"><script>x<\u002fscript>' as ReplayComment["state"];

  const html = render({ data: { comments: [comment({ state: forged, answers: [] })] } });

  assert.match(html, /lsr-replay-state">What changed here cannot be shown\.</);
  assert.doesNotMatch(html, /<script>/, "the served string never reaches the page");
  assert.doesNotMatch(html, /undefined/);
});

test("the nav knows where it is: progress, dots, a first Previous and a last Done", () => {
  const data: ReplayData = { comments: [comment(), comment({ id: "c2" }), comment({ id: "c3" })] };

  const first = renderReplayOverlay({ data, current: 0, seen: new Set() }, renderer);
  assert.match(first, /Comment 1 of 3/);
  assert.match(first, /lsr-replay-prev" disabled>Previous</);
  assert.match(first, /lsr-replay-next">Next</);
  assert.match(first, /data-index="0" aria-label="Comment 1" aria-current="true"/);
  assert.match(first, /data-index="2" aria-label="Comment 3" aria-current="false"/);

  const last = renderReplayOverlay({ data, current: 2, seen: new Set() }, renderer);
  assert.match(last, /Comment 3 of 3/);
  assert.match(last, /lsr-replay-next">Done</);
  assert.doesNotMatch(last, /lsr-replay-prev" disabled/);
});

test("every card offers the way out, and the dialog says what it is", () => {
  const html = render();

  assert.match(html, /lsr-replay-skip">Skip to the diff</);
  assert.match(html, /role="dialog" aria-modal="true" aria-label="What happened between rounds"/);
});

test("a current index off either end lands on a real card instead of a blank dialog", () => {
  const data: ReplayData = { comments: [comment(), comment({ id: "c2" })] };

  assert.match(
    renderReplayOverlay({ data, current: 9, seen: new Set() }, renderer),
    /Comment 2 of 2/,
  );
  assert.match(
    renderReplayOverlay({ data, current: -1, seen: new Set() }, renderer),
    /Comment 1 of 2/,
  );
});

test("nothing to replay renders nothing at all", () => {
  assert.equal(
    renderReplayOverlay({ data: { comments: [] }, current: 0, seen: new Set() }, renderer),
    "",
  );
});

test("the reviewer's words and the agent's arrive escaped, not parsed", () => {
  const html = render({
    data: {
      comments: [
        comment({
          file: "src/<b>.ts",
          selected_text: "<script>alert(1)</script>",
          comment: "use <em> here",
          note: "done & <tested>",
        }),
      ],
    },
  });

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<em>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /use &lt;em&gt; here/);
  assert.match(html, /done &amp; &lt;tested&gt;/);
});

test("serious, as decided: no exclamation, no emoji, no transition in the markup", () => {
  const html = render();

  assert.doesNotMatch(html, /!/);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
});

function entry(
  role: "reviewer" | "agent",
  comment: string,
  roundIndex?: number,
): ConversationEntry {
  return {
    role,
    at: "2025-01-01T00:05:00.000Z",
    ...(roundIndex === undefined ? {} : { roundIndex }),
    prompts: [{ type: "message", comment }],
  };
}

const rounds: RoundMark[] = [
  { index: 0, at: "2025-01-01T00:00:00.000Z" },
  { index: 1, at: "2025-01-01T01:00:00.000Z" },
];

test("the round reply is what the agent said after the comments it answers, both sides of the boundary", () => {
  const reply = agentRoundReply(
    [
      entry("agent", "greeting nobody asked about", 0),
      entry("reviewer", "fix this", 0),
      entry("agent", "renamed it", 0),
      entry("agent", "and regrouped", 1),
    ],
    rounds,
    new Set(),
  );

  assert.equal(reply, "renamed it\n\nand regrouped");
});

test("a first round has no round reply, and neither does a silent agent", () => {
  assert.equal(
    agentRoundReply(
      [entry("agent", "hello", 0)],
      [{ index: 0, at: "2025-01-01T00:00:00.000Z" }],
      new Set(),
    ),
    undefined,
  );
  assert.equal(agentRoundReply([entry("reviewer", "fix this", 0)], rounds, new Set()), undefined);
});

test("the round reply is the agent's --to main; a note in an item's thread stays on that card", () => {
  const said = (prompts: ConversationEntry["prompts"]): ConversationEntry => ({
    role: "agent",
    at: "2025-01-01T00:05:00.000Z",
    roundIndex: 1,
    prompts,
  });
  const reply = agentRoundReply(
    [
      entry("reviewer", "fix this", 0),
      said([
        { type: "reply", thread: "t1", comment: "done: fixed" },
        { type: "reply", thread: "main", comment: "also rebased" },
        { type: "resolve", thread: "t1", resolved: true },
      ]),
    ],
    rounds,
    new Set(),
  );

  assert.equal(reply, "also rebased");
});

/** The agent's words at `minute`, as `reply --to` writes them. */
function replyAt(minute: number, thread: string, comment: string): ConversationEntry {
  return {
    role: "agent",
    at: `2025-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
    roundIndex: 1,
    prompts: [{ type: "reply", thread, comment }],
  };
}

test("a round reply the panel already drew is left out; what it never drew stays", () => {
  const asked: ConversationEntry = {
    role: "reviewer",
    at: "2025-01-01T00:01:00.000Z",
    roundIndex: 0,
    prompts: [{ type: "message", id: "t1", comment: "fix this" }],
  };
  const early = replyAt(2, "main", "on it, renaming first");
  const late = replyAt(3, "main", "and rebased");
  // Seen as the panel keys it: the reply was drawn before the round came.
  const seen = agentMessages([asked, early]);

  assert.equal(agentRoundReply([asked, early, late], rounds, seen), "and rebased");
  assert.equal(
    agentRoundReply([asked, early], rounds, seen),
    undefined,
    "all of it seen: no round reply at all, not an empty one",
  );
});

test("an agent message the panel drew is seen too, keyed by its own thread", () => {
  const asked = entry("reviewer", "fix this", 0);
  const told: ConversationEntry = {
    role: "agent",
    at: "2025-01-01T00:06:00.000Z",
    roundIndex: 1,
    prompts: [{ type: "message", id: "t9", comment: "heads up: renamed the module" }],
  };

  assert.equal(agentRoundReply([asked, told], rounds, agentMessages([asked, told])), undefined);
  assert.equal(agentRoundReply([asked, told], rounds, new Set()), "heads up: renamed the module");
});

/** The panel's key for the default comment's note: its thread and the moment it was said. */
const NOTE_SEEN = new Set(["c1 2025-01-01T00:07:00.000Z"]);

test("an answer the panel already showed is left off the card; what changed still shows", () => {
  const html = render({
    data: { comments: [comment({ note_at: "2025-01-01T00:07:00.000Z" })] },
    seen: NOTE_SEEN,
    roundReply: "Round summary: renamed things.",
  });

  assert.doesNotMatch(html, /lsr-replay-answer"/, "no answer block at all, not an empty one");
  assert.doesNotMatch(html, /renamed it to total/);
  assert.doesNotMatch(html, /Round summary/, "a seen answer is not replaced by the round reply");
  assert.doesNotMatch(html, /agent did not map this/, "the comment was answered, just not anew");
  assert.match(html, /What changed/);
  assert.match(html, /lsr-replay-diff/);
});

test("no change and an answer already read: the card points to no reply it does not hold", () => {
  const html = render({
    data: { comments: [comment({ answers: [], note_at: "2025-01-01T00:07:00.000Z" })] },
    seen: NOTE_SEEN,
  });

  assert.doesNotMatch(html, /see the reply/);
  assert.match(html, /No code change — you read the reply in its thread\./);
});

test("no change and no words from the agent at all: just no code change", () => {
  const html = render({ data: { comments: [comment({ answers: [], note: undefined })] } });

  assert.doesNotMatch(html, /see the reply/);
  assert.match(html, /lsr-replay-nochange">No code change\.</);
});

test("an answer the panel has not shown stays on the card", () => {
  const html = render({
    data: { comments: [comment({ note_at: "2025-01-01T00:08:00.000Z" })] },
    seen: NOTE_SEEN,
  });

  assert.match(html, /lsr-replay-note">renamed it to total</);
});

test("an answer with no stamp cannot be told seen, so it is shown", () => {
  const html = render({ data: { comments: [comment()] }, seen: NOTE_SEEN });

  assert.match(html, /The agent's answer/);
});

test("a replay has news while any card shows a change or words the panel did not", () => {
  const silent = comment({
    answers: [],
    note_at: "2025-01-01T00:07:00.000Z",
  });
  const news = (over: Partial<ReplayComment>, roundReply?: string): boolean =>
    replayHasNews({
      data: { comments: [silent, comment({ ...silent, ...over })] },
      seen: NOTE_SEEN,
      ...(roundReply === undefined ? {} : { roundReply }),
    });

  assert.equal(news({}), false, "every answer seen and nothing changed: nothing new");
  assert.equal(news({ answers: comment().answers }), true, "a change is news");
  assert.equal(news({ note_at: "2025-01-01T00:08:00.000Z" }), true, "an unseen answer is");
  assert.equal(news({ note: undefined }, "and rebased"), true, "so is an unseen round reply");
  assert.equal(news({ state: "oversize" }), true, "a change too big to show is still a change");
  assert.equal(news({ state: "unreachable" }), false, "history gone says nothing new");
  assert.equal(
    news({ state: "unreachable", note: undefined }, "and rebased"),
    false,
    "a status-only card borrows no round reply, so it has none to be news",
  );
});
