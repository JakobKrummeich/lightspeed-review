import { test } from "node:test";
import assert from "node:assert/strict";
import { createReplayRefresher } from "../../../src/browser/dom/replay-refresh.ts";
import type { ReplayOpening } from "../../../src/browser/dom/replay-overlay.ts";
import type { ReplayComment, ReplayData } from "../../../src/rounds/replay.ts";

/** The smallest data a card needs; the id names which response it was. */
function dataOf(id: string): ReplayData {
  const comment: ReplayComment = {
    id,
    file: "src/api.ts",
    group: "API",
    anchor: { side: "new", line_start: 3, line_end: 4 },
    selected_text: "+const x = 1;",
    comment: "this name says nothing",
    status: "addressed",
    declared: true,
    state: "ok",
    answers: [],
    note: "renamed it",
  };
  return { comments: [comment] };
}

function idOf(opening: ReplayOpening | undefined): string | undefined {
  return opening?.data.comments[0]?.id ?? undefined;
}

/**
 * A refresher whose fetches answer only when the test says so, recording every
 * call to the page: openings offered, shown, and rounds marked replayed.
 */
function harness(replayed: number[] = []) {
  const pending: Array<{ resolve(data: ReplayData): void; reject(error: Error): void }> = [];
  const offers: Array<string | undefined> = [];
  const opened: Array<string | undefined> = [];
  const refresh = createReplayRefresher({
    fetch: () =>
      new Promise<ReplayData>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    wasReplayed: (round) => replayed.includes(round),
    markReplayed: (round) => replayed.push(round),
    open: (opening) => opened.push(idOf(opening)),
    offer: (opening) => offers.push(idOf(opening)),
  });
  return { refresh, pending, offers, opened, replayed };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a round with comments is offered and auto-shown, and marked before it shows", async () => {
  const h = harness();

  h.refresh({ round: 3, roundReply: undefined, ended: false });
  h.pending[0]?.resolve(dataOf("first"));
  await settled();

  assert.deepEqual(h.offers, [undefined, "first"], "withdrawn while in flight, then offered");
  assert.deepEqual(h.opened, ["first"]);
  assert.deepEqual(h.replayed, [3]);
});

test("a round this browser already showed is offered for reopening but not shown again", async () => {
  const h = harness([3]);

  h.refresh({ round: 3, roundReply: undefined, ended: false });
  h.pending[0]?.resolve(dataOf("again"));
  await settled();

  assert.deepEqual(h.offers, [undefined, "again"]);
  assert.deepEqual(h.opened, []);
});

test("an ended review and an empty round both leave nothing to reopen", async () => {
  const h = harness();

  h.refresh({ round: 3, roundReply: undefined, ended: true });
  h.pending[0]?.resolve(dataOf("ended"));
  h.refresh({ round: 4, roundReply: undefined, ended: false });
  h.pending[1]?.resolve({ comments: [] });
  await settled();

  assert.deepEqual(h.offers, [undefined, undefined]);
  assert.deepEqual(h.opened, []);
});

test("a stale response landing after the newer one is dropped", async () => {
  const h = harness();

  h.refresh({ round: 4, roundReply: "old", ended: false });
  h.refresh({ round: 5, roundReply: "new", ended: false });
  h.pending[1]?.resolve(dataOf("new"));
  await settled();
  h.pending[0]?.resolve(dataOf("old"));
  await settled();

  assert.deepEqual(h.offers, [undefined, undefined, "new"], "the old response changed nothing");
  assert.deepEqual(h.opened, ["new"]);
  assert.deepEqual(h.replayed, [5], "the old round's turn was never burned");
});

test("a stale response landing before the newer one is dropped too", async () => {
  const h = harness();

  h.refresh({ round: 4, roundReply: "old", ended: false });
  h.refresh({ round: 5, roundReply: "new", ended: false });
  h.pending[0]?.resolve(dataOf("old"));
  await settled();
  h.pending[1]?.resolve(dataOf("new"));
  await settled();

  assert.deepEqual(h.offers, [undefined, undefined, "new"]);
  assert.deepEqual(h.opened, ["new"]);
  assert.deepEqual(h.replayed, [5]);
});

test("a failed re-group fetch withdraws the previous round's cards", async () => {
  const h = harness();

  h.refresh({ round: 4, roundReply: undefined, ended: false });
  h.pending[0]?.resolve(dataOf("shown"));
  await settled();
  h.refresh({ round: 5, roundReply: undefined, ended: false });
  h.pending[1]?.reject(new Error("gone"));
  await settled();

  assert.equal(h.offers.at(-1), undefined, "nothing of round 4 is left to reopen");
  assert.deepEqual(h.opened, ["shown"], "the failure itself shows nothing");
});
