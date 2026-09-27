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
    state: "ok",
    answers: [],
    note: "renamed it",
  };
  return { comments: [comment] };
}

function idOf(opening: ReplayOpening | undefined): string | undefined {
  return opening?.data.comments[0]?.id ?? undefined;
}

/** `claims`: the rounds this page claimed as they arrived; a showing spends one. */
function harness(claims: number[] = []) {
  const pending: Array<{ resolve(data: ReplayData): void; reject(error: Error): void }> = [];
  const offers: Array<string | undefined> = [];
  const opened: Array<string | undefined> = [];
  const failures = { count: 0 };
  const refresher = createReplayRefresher({
    fetch: () =>
      new Promise<ReplayData>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    claimed: (round) => {
      const at = claims.indexOf(round);
      if (at >= 0) claims.splice(at, 1);
      return at >= 0;
    },
    open: (opening) => opened.push(idOf(opening)),
    offer: (opening) => offers.push(idOf(opening)),
    failed: () => (failures.count += 1),
  });
  return { ...refresher, pending, offers, opened, claims, failures };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("a round this page claimed is offered and auto-shown, spending the claim", async () => {
  const h = harness([3]);

  h.refresh({ round: 3, roundReply: undefined, ended: false });
  h.pending[0]?.resolve(dataOf("first"));
  await settled();

  assert.deepEqual(h.offers, [undefined, "first"], "withdrawn while in flight, then offered");
  assert.deepEqual(h.opened, ["first"]);
  assert.equal(h.claims.length, 0);
});

test("a round this page did not claim is offered for reopening but not shown", async () => {
  // Shown before, or claimed by another tab on the same review.
  const h = harness();

  h.refresh({ round: 3, roundReply: undefined, ended: false });
  h.pending[0]?.resolve(dataOf("again"));
  await settled();

  assert.deepEqual(h.offers, [undefined, "again"]);
  assert.deepEqual(h.opened, []);
});

test("an ended review and an empty round both leave nothing to reopen", async () => {
  const h = harness([3, 4]);

  h.refresh({ round: 3, roundReply: undefined, ended: true });
  h.pending[0]?.resolve(dataOf("ended"));
  h.refresh({ round: 4, roundReply: undefined, ended: false });
  h.pending[1]?.resolve({ comments: [] });
  await settled();

  assert.deepEqual(h.offers, [undefined, undefined]);
  assert.deepEqual(h.opened, []);
});

test("a stale response landing after the newer one is dropped", async () => {
  const h = harness([4, 5]);

  h.refresh({ round: 4, roundReply: "old", ended: false });
  h.refresh({ round: 5, roundReply: "new", ended: false });
  h.pending[1]?.resolve(dataOf("new"));
  await settled();
  h.pending[0]?.resolve(dataOf("old"));
  await settled();

  assert.deepEqual(h.offers, [undefined, undefined, "new"], "the old response changed nothing");
  assert.deepEqual(h.opened, ["new"]);
  assert.deepEqual(h.claims, [4], "the old response spent no claim");
});

test("a stale response landing before the newer one is dropped too", async () => {
  const h = harness([4, 5]);

  h.refresh({ round: 4, roundReply: "old", ended: false });
  h.refresh({ round: 5, roundReply: "new", ended: false });
  h.pending[0]?.resolve(dataOf("old"));
  await settled();
  h.pending[1]?.resolve(dataOf("new"));
  await settled();

  assert.deepEqual(h.offers, [undefined, undefined, "new"]);
  assert.deepEqual(h.opened, ["new"]);
  assert.deepEqual(h.claims, [4]);
});

test("a failed re-group fetch withdraws the previous round's cards", async () => {
  const h = harness([4, 5]);

  h.refresh({ round: 4, roundReply: undefined, ended: false });
  h.pending[0]?.resolve(dataOf("shown"));
  await settled();
  h.refresh({ round: 5, roundReply: undefined, ended: false });
  h.pending[1]?.reject(new Error("gone"));
  await settled();

  assert.equal(h.offers.at(-1), undefined, "nothing of round 4 is left to reopen");
  assert.deepEqual(h.opened, ["shown"], "the failure itself shows nothing");
});

test("a failed fetch says so, so the reopen can stay and ask again", async () => {
  const h = harness([4]);

  h.refresh({ round: 4, roundReply: undefined, ended: false });
  h.pending[0]?.reject(new Error("boom"));
  await settled();

  assert.equal(h.failures.count, 1);
  assert.deepEqual(h.opened, []);
});

test("a retry fetches the same round again and opens it: asked by hand, no claim needed", async () => {
  const h = harness();
  h.refresh({ round: 4, roundReply: "said", ended: false });
  h.pending[0]?.reject(new Error("boom"));
  await settled();

  h.retry();
  h.pending[1]?.resolve(dataOf("again"));
  await settled();

  assert.deepEqual(h.offers, [undefined, undefined, "again"], "withdrawn while it asks");
  assert.deepEqual(h.opened, ["again"]);
});

test("a retry spends the round's claim, so nothing opens it twice", async () => {
  const h = harness([4]);
  h.refresh({ round: 4, roundReply: undefined, ended: false });
  h.pending[0]?.reject(new Error("boom"));
  await settled();

  h.retry();
  h.pending[1]?.resolve(dataOf("again"));
  await settled();

  assert.deepEqual(h.opened, ["again"]);
  assert.equal(h.claims.length, 0);
});

test("a failure the newer round superseded, or one on an ended review, offers no retry", async () => {
  const h = harness();

  h.refresh({ round: 4, roundReply: undefined, ended: false });
  h.refresh({ round: 5, roundReply: undefined, ended: true });
  h.pending[0]?.reject(new Error("stale"));
  h.pending[1]?.reject(new Error("ended"));
  await settled();

  assert.equal(h.failures.count, 0);
});

test("with nothing asked yet, a retry asks nothing", () => {
  const h = harness();

  h.retry();

  assert.equal(h.pending.length, 0);
});
