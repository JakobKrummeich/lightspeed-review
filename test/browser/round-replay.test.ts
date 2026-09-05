import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiffRenderer } from "../../src/browser/diff-renderer.ts";
import {
  agentRoundReply,
  renderReplayOverlay,
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
    declared: true,
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
  const view: ReplayView = { data: { comments: [comment()] }, current: 0, ...over };
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
    data: { comments: [comment({ declared: false, note: undefined })] },
    roundReply: "Round summary: renamed things.",
  });

  assert.match(html, /lsr-replay-unmapped">agent did not map this</);
  assert.match(html, /The agent's round reply/);
  assert.match(html, /lsr-replay-note">Round summary: renamed things\.</);
  assert.doesNotMatch(html, /The agent's answer</);
});

test("a declared card never borrows the round reply, even without a note of its own", () => {
  const html = render({
    data: { comments: [comment({ declared: true, note: undefined })] },
    roundReply: "Round summary: renamed things.",
  });

  assert.doesNotMatch(html, /Round summary/);
  assert.doesNotMatch(html, /lsr-replay-unmapped/);
  assert.doesNotMatch(html, /lsr-replay-answer"/, "no empty answer frame either");
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

  const first = renderReplayOverlay({ data, current: 0 }, renderer);
  assert.match(first, /Comment 1 of 3/);
  assert.match(first, /lsr-replay-prev" disabled>Previous</);
  assert.match(first, /lsr-replay-next">Next</);
  assert.match(first, /data-index="0" aria-label="Comment 1" aria-current="true"/);
  assert.match(first, /data-index="2" aria-label="Comment 3" aria-current="false"/);

  const last = renderReplayOverlay({ data, current: 2 }, renderer);
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

  assert.match(renderReplayOverlay({ data, current: 9 }, renderer), /Comment 2 of 2/);
  assert.match(renderReplayOverlay({ data, current: -1 }, renderer), /Comment 1 of 2/);
});

test("nothing to replay renders nothing at all", () => {
  assert.equal(renderReplayOverlay({ data: { comments: [] }, current: 0 }, renderer), "");
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
  );

  assert.equal(reply, "renamed it\n\nand regrouped");
});

test("a first round has no round reply, and neither does a silent agent", () => {
  assert.equal(
    agentRoundReply([entry("agent", "hello", 0)], [{ index: 0, at: "2025-01-01T00:00:00.000Z" }]),
    undefined,
  );
  assert.equal(agentRoundReply([entry("reviewer", "fix this", 0)], rounds), undefined);
});
