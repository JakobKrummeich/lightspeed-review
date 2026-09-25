/**
 * The 3.0 turn machine over HTTP: the reviewer's Send, delivery to a waiting
 * agent, `reply`, `work`, `publish`, and re-running any of them after a kill.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { SessionRecord } from "../src/session-store.ts";
import {
  annotation,
  deliverIntoTheVoid,
  openStream,
  parkedFetch,
  pollAndAck,
  pollOnce,
  postDelivered,
  postFeedback,
  postReply,
  postSession,
  postSessionRaw,
  postWork,
  sessionPayload,
  withServer,
  type RunningServer,
} from "./helpers/review-server.ts";

const message = { type: "message", comment: "why a new table?" };

async function send(url: string, key: string, prompts: unknown[]): Promise<void> {
  const { status } = await postFeedback(url, key, { prompts, ended: false });
  assert.equal(status, 200);
}

/** A session whose agent holds one delivered, acknowledged batch: `t1` and `t2`. */
async function digesting(running: RunningServer): Promise<string> {
  const { key } = await postSession(running.url);
  await send(running.url, key, [annotation, message]);
  await pollAndAck(running.url, key);
  return key;
}

async function working(running: RunningServer, head = "head-1"): Promise<string> {
  const key = await digesting(running);
  assert.equal((await postWork(running.url, key, { plan: "one transaction", head })).status, 200);
  return key;
}

function publish(url: string, body: Record<string, unknown> = {}): Promise<Response> {
  return postSessionRaw(url, {
    ...sessionPayload,
    headCommit: "head-2",
    verb: "publish",
    intents: ["wrap the writes"],
    ...body,
  });
}

async function errorOf(response: Response): Promise<{ code: string; help: string[] }> {
  const body = (await response.json()) as { error: { code: string }; help: string[] };
  return { code: body.error.code, help: body.help };
}

function agentSaid(session: SessionRecord): unknown[] {
  return session.conversation.filter((entry) => entry.role === "agent").flatMap((e) => e.prompts);
}

test("every item the reviewer sends opens a thread with a short id, minted in order", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    await send(url, key, [{ ...annotation, id: "evt_forged" }, message]);
    await send(url, key, [message]);

    const session = store.get(key)!;
    assert.deepEqual(
      session.pending.map((prompt) => (prompt as { id?: string }).id),
      ["t1", "t2", "t3"],
    );
    assert.deepEqual(
      session.conversation.flatMap((entry) => entry.prompts),
      session.pending,
    );
  });
});

test("a reply or resolve naming a thread that does not exist is refused whole", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await send(url, key, [annotation]);

    const response = await postFeedback(url, key, {
      prompts: [message, { type: "reply", thread: "t9", comment: "and?" }],
      ended: false,
    });

    assert.equal(response.status, 422);
    assert.partialDeepStrictEqual(response.json, { error: { code: "feedback_item_unknown" } });
    assert.equal(store.get(key)!.pending.length, 1);
  });
});

test("replies and resolves travel in the next Send beside new items", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await send(url, key, [annotation]);

    await send(url, key, [
      { type: "reply", thread: "t1", comment: "and on a 503?" },
      { type: "resolve", thread: "t1", resolved: true },
      { type: "reply", thread: "t2", comment: "a thread opened in this very Send" },
      message,
    ]);

    assert.equal(store.get(key)!.pending.length, 5);
  });
});

test("a poll with a queue hands the batch over as items and gives the agent the turn", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await send(url, key, [annotation, message]);

    const polled = await pollOnce(url, key);

    assert.partialDeepStrictEqual(polled, {
      status: "feedback",
      ended: false,
      turn: "agent digesting",
      round: 1,
      items: [
        { id: "t1", status: "new", file: "src/api/users.ts", reviewer: ["wrap in a transaction"] },
        { id: "t2", status: "new", reviewer: ["why a new table?"] },
      ],
    });
    const session = store.get(key)!;
    assert.deepEqual(session.pending, []);
    assert.equal(session.batch?.id, polled.delivery);
    assert.equal(session.batch?.acked, false);
    assert.deepEqual(session.turn.holder, "agent");

    await postDelivered(url, key, { delivery: polled.delivery });
    assert.equal(store.get(key)!.batch?.acked, true);
  });
});

test("an acknowledgement naming another batch confirms nothing", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await send(url, key, [annotation]);
    await pollOnce(url, key);

    const response = await postDelivered(url, key, { delivery: "evt_other" });

    assert.deepEqual(await response.json(), { confirmed: false });
    assert.equal(store.get(key)!.batch?.acked, false);
    assert.equal((await postDelivered(url, key, {})).status, 400);
  });
});

test("a waiting command re-run while the agent digests is handed the same batch again", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await digesting(running);
    const first = store.get(key)!.batch;

    const again = await pollOnce(url, key);

    assert.equal(again.delivery, first?.id);
    assert.equal((again.items as unknown[]).length, 2);
    assert.deepEqual(store.get(key)!.batch, first);
  });
});

test("a batch delivered into a dead connection is kept, and the re-run gets it", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await send(url, key, [annotation]);

    await deliverIntoTheVoid(url, key);

    assert.equal(store.get(key)!.batch?.acked, false);
    const again = await pollOnce(url, key);
    assert.equal(again.delivery, store.get(key)!.batch?.id);
    assert.partialDeepStrictEqual(again.items, [{ id: "t1" }]);
  });
});

test("a poll while the agent works is refused, naming publish, and moves nothing", async () => {
  await withServer(async (running) => {
    const key = await working(running);
    const before = running.store.get(key);

    const response = await fetch(`${running.url}/api/poll?key=${key}`);

    assert.equal(response.status, 422);
    const refused = await errorOf(response);
    assert.equal(refused.code, "turn_still_yours");
    assert.match(refused.help[0]!, /lightspeed publish/);
    assert.deepEqual(running.store.get(key), before);
  });
});

test("a parked poll moves no turn and is answered by the reviewer's next Send", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    const polling = await parkedFetch(url, key);
    assert.equal(store.get(key)!.turn.holder, "reviewer");

    await send(url, key, [message]);

    const answer = (await (await polling.answer).json()) as Record<string, unknown>;
    assert.equal(answer.turn, "agent digesting");
    assert.partialDeepStrictEqual(answer.items, [{ id: "t1", status: "new" }]);
  });
});

test("the newest poll takes over listening: the older one is told it was superseded", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    const orphan = await parkedFetch(url, key);
    const current = await parkedFetch(url, key);

    const told = (await (await orphan.answer).json()) as Record<string, unknown>;
    assert.equal(told.superseded, true);
    assert.match(String(told.message), /another lightspeed command took over listening/);
    assert.equal(store.get(key)!.turn.holder, "reviewer", "superseding moves no turn");

    await send(url, key, [message]);
    const answer = (await (await current.answer).json()) as Record<string, unknown>;
    assert.equal(answer.turn, "agent digesting");
    assert.partialDeepStrictEqual(answer.items, [{ id: "t1", status: "new" }]);
  });
});

test("the reviewer's Send is refused while the agent holds the turn; ending never is", async () => {
  await withServer(async ({ url, store }) => {
    const reading = await digesting({ url, store, server: undefined as never });
    const refused = await postFeedback(url, reading, { prompts: [message], ended: false });
    assert.equal(refused.status, 409);
    assert.equal((refused.json as { error: { code: string } }).error.code, "agent_holds_turn");
    assert.match(
      (refused.json as { error: { message: string } }).error.message,
      /reading your last batch/,
    );
    assert.equal(store.get(reading)!.pending.length, 0, "nothing was queued");

    assert.equal((await postWork(url, reading, { plan: "split it", head: "h" })).status, 200);
    const whileWorking = await postFeedback(url, reading, { prompts: [message], ended: false });
    assert.equal(whileWorking.status, 409);
    assert.match(
      (whileWorking.json as { error: { message: string } }).error.message,
      /working on your feedback/,
    );

    const ending = await postFeedback(url, reading, { prompts: [], ended: true });
    assert.equal(ending.status, 200);
    assert.equal(store.get(reading)!.status, "ended");
  });
});

/**
 * Words on an ending Send while the agent holds the turn would land where no
 * command ever hands them over: the agent's next call only hears the review
 * ended. Refused whole, so nothing is lost; ending with nothing always goes.
 */
test("an ending Send that carries words is refused while the agent holds the turn", async () => {
  await withServer(async (running) => {
    const key = await digesting(running);
    assert.equal((await postWork(running.url, key, { plan: "split it", head: "h" })).status, 200);

    const refused = await postFeedback(running.url, key, { prompts: [message], ended: true });

    assert.equal(refused.status, 409);
    const body = refused.json as { error: { code: string; message: string }; help: string[] };
    assert.equal(body.error.code, "agent_holds_turn");
    assert.match(body.error.message, /would never be read/);
    assert.match(body.help.join(" "), /End without Sending/);
    assert.notEqual(running.store.get(key)!.status, "ended", "the review is not ended");
    assert.equal(running.store.get(key)!.pending.length, 0, "nothing was queued");
  });
});

test("End without Sending ends a review the agent is still reading", async () => {
  await withServer(async (running) => {
    const key = await digesting(running);
    const ending = await postFeedback(running.url, key, { prompts: [], ended: true });
    assert.equal(ending.status, 200);
    assert.equal(running.store.get(key)!.status, "ended");
  });
});

test("ending releases a parked poll with the review's account of itself", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    const polling = await parkedFetch(url, key);

    await fetch(`${url}/api/session/${key}/end`, { method: "POST" });

    assert.equal(store.get(key)?.endedBy, "agent");
    assert.deepEqual(await (await polling.answer).json(), {
      status: "ended",
      ended: true,
      items: [],
      turn: "ended",
      round: 1,
      approval: { verdict: "none", approved: 0, unapproved: 1, swept: 0, total: 1 },
      endedBy: "agent",
    });
  });
});

test("Send & End hands its last words over with the end, once", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    await postFeedback(url, key, { prompts: [message], ended: true });

    const polled = await pollOnce(url, key);
    assert.equal(polled.ended, true);
    assert.equal(polled.endedBy, "reviewer");
    assert.partialDeepStrictEqual(polled.items, [{ id: "t1", reviewer: ["why a new table?"] }]);
    assert.deepEqual(store.get(key)!.pending, []);
    assert.deepEqual((await pollOnce(url, key)).items, []);
  });
});

test("reply posts every answer under its item and hands the turn back", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await digesting(running);

    const response = await postReply(url, key, {
      replies: [
        { to: "t1", text: "it retries 3x" },
        { to: "main", text: "all else is clear" },
      ],
    });

    assert.equal(response.status, 200);
    assert.partialDeepStrictEqual(await response.json(), { turn: "reviewer", replied: 2 });
    const session = store.get(key)!;
    assert.equal(session.turn.holder, "reviewer");
    assert.deepEqual(agentSaid(session), [
      { type: "reply", thread: "t1", comment: "it retries 3x" },
      { type: "reply", thread: "main", comment: "all else is clear" },
    ]);
    assert.equal(session.lastHandback?.verb, "reply");
    assert.equal(session.lastHandback?.batch, session.batch?.id);
  });
});

test("the same reply re-run after a kill posts nothing twice", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await digesting(running);
    const body = { replies: [{ to: "t1", text: "it retries 3x" }] };
    await postReply(url, key, body);

    const rerun = await postReply(url, key, body);

    assert.equal(rerun.status, 200);
    assert.partialDeepStrictEqual(await rerun.json(), { rerun: true, turn: "reviewer" });
    assert.equal(agentSaid(store.get(key)!).length, 1);
  });
});

test("a re-run reply after an unread delivery re-attaches instead of answering it", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await digesting(running);
    const body = { replies: [{ to: "t1", text: "it retries 3x" }] };
    await postReply(url, key, body);
    await send(url, key, [{ type: "reply", thread: "t1", comment: "and on a 503?" }]);
    await pollOnce(url, key);

    const rerun = await postReply(url, key, body);

    assert.partialDeepStrictEqual(await rerun.json(), { rerun: true, turn: "agent digesting" });
    assert.equal(agentSaid(store.get(key)!).length, 1);
    const again = await pollOnce(url, key);
    assert.partialDeepStrictEqual(again.items, [
      { id: "t1", status: "reply", you: "it retries 3x", reviewer: ["and on a 503?"] },
    ]);
  });
});

test("the same words after a batch that was read are a new reply", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await digesting(running);
    const body = { replies: [{ to: "t1", text: "yes" }] };
    await postReply(url, key, body);
    await send(url, key, [{ type: "reply", thread: "t1", comment: "sure?" }]);
    await pollAndAck(url, key);

    const second = await postReply(url, key, body);

    assert.equal(second.status, 200);
    assert.equal(agentSaid(store.get(key)!).length, 2);
  });
});

test("reply without the turn is refused, naming open", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);

    const response = await postReply(url, key, { replies: [{ to: "main", text: "hello?" }] });

    assert.equal(response.status, 422);
    const refused = await errorOf(response);
    assert.equal(refused.code, "turn_not_yours");
    assert.match(refused.help[0]!, /lightspeed open feature-auth main/);
    assert.deepEqual(store.get(key)!.conversation, []);
  });
});

test("a reply with nothing to say, or to an item that does not exist, is refused", async () => {
  await withServer(async (running) => {
    const { url } = running;
    const key = await digesting(running);

    assert.equal((await postReply(url, key, { replies: [] })).status, 400);
    assert.equal((await postReply(url, key, { replies: [{ to: "t1", text: " " }] })).status, 400);
    const unknown = await postReply(url, key, { replies: [{ to: "t7", text: "hm" }] });
    assert.equal(unknown.status, 422);
    assert.equal((await errorOf(unknown)).code, "feedback_item_unknown");
  });
});

test("reply from working is legal only while nothing changed since work", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await working(running, "head-1");

    const moved = await postReply(url, key, {
      replies: [{ to: "t1", text: "stuck" }],
      head: "head-2",
      clean: true,
    });
    const dirty = await postReply(url, key, {
      replies: [{ to: "t1", text: "stuck" }],
      head: "head-1",
      clean: false,
    });

    assert.equal((await errorOf(moved)).code, "turn_still_yours");
    assert.equal((await errorOf(dirty)).code, "turn_still_yours");
    const untouched = await postReply(url, key, {
      replies: [{ to: "t1", text: "stuck: which table?" }],
      head: "head-1",
      clean: true,
    });
    assert.equal(untouched.status, 200);
    assert.equal(store.get(key)!.turn.holder, "reviewer");
  });
});

test("a reply into an ended review is refused", async () => {
  await withServer(async (running) => {
    const { url } = running;
    const key = await digesting(running);
    await fetch(`${url}/api/session/${key}/end`, { method: "POST" });

    const response = await postReply(url, key, { replies: [{ to: "t1", text: "late" }] });

    assert.equal(response.status, 409);
  });
});

test("work turns digesting into working, keeping the HEAD it started from", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await digesting(running);

    const first = await postWork(url, key, { plan: "one transaction", head: "head-1" });
    const again = await postWork(url, key, { plan: "one transaction", head: "head-9" });
    const refined = await postWork(url, key, { plan: "one transaction, then tests" });

    assert.partialDeepStrictEqual(await first.json(), { turn: "agent working", changed: true });
    assert.partialDeepStrictEqual(await again.json(), { changed: false });
    assert.partialDeepStrictEqual(await refined.json(), { changed: true });
    assert.partialDeepStrictEqual(store.get(key)!.turn, {
      holder: "agent",
      mode: "working",
      note: "one transaction, then tests",
      head: "head-1",
    });
  });
});

test("work is refused without the turn, on an ended review, and without a plan", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);

    const notYours = await postWork(url, key, { plan: "anything" });
    assert.equal((await errorOf(notYours)).code, "turn_not_yours");
    assert.equal((await postWork(url, key, { plan: " " })).status, 400);
    await fetch(`${url}/api/session/${key}/end`, { method: "POST" });
    assert.equal((await postWork(url, key, { plan: "anything" })).status, 409);
  });
});

test("the reviewer's page is told when the agent takes the turn and when it starts work", async () => {
  await withServer(async ({ url }) => {
    const { key } = await postSession(url);
    const stream = await openStream(url, key);
    await stream.until(/event: presence/);
    await send(url, key, [annotation]);

    await pollAndAck(url, key);
    const taken = await stream.until(/"mode":"digesting"/);
    assert.match(taken, /"holder":"agent"/);
    // The page says how many items the agent is reading.
    assert.match(taken, /"items":1/);
    await postWork(url, key, { plan: "splitting the helper out" });
    assert.match(await stream.until(/"mode":"working"/), /splitting the helper out/);
    stream.close();
  });
});

test("publish opens the next round, hands the turn back and files its notes", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await working(running);

    const response = await publish(url, { notes: [{ to: "t1", text: "done: one transaction" }] });

    assert.equal(response.status, 200);
    assert.partialDeepStrictEqual(await response.json(), { turn: "reviewer", round: 2 });
    const session = store.get(key)!;
    assert.equal(session.rounds.length, 2);
    assert.equal(session.turn.holder, "reviewer");
    assert.equal(session.lastHandback?.verb, "publish");
    const note = session.conversation.at(-1)!;
    assert.equal(note.role, "agent");
    assert.equal(note.roundIndex, 1);
    assert.deepEqual(note.prompts, [
      { type: "reply", thread: "t1", comment: "done: one transaction" },
    ]);
  });
});

test("a publish re-run after a kill opens no second round", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await working(running);
    const notes = [{ to: "t1", text: "done" }];
    await publish(url, { notes });

    const rerun = await publish(url, { notes });

    assert.equal(rerun.status, 200);
    assert.partialDeepStrictEqual(await rerun.json(), { rerun: true });
    assert.equal(store.get(key)!.rounds.length, 2);
    assert.equal(agentSaid(store.get(key)!).length, 1);
  });
});

test("publish is refused from every state but working with new commits", async () => {
  await withServer(async (running) => {
    const { url } = running;
    const { key } = await postSession(url);
    const reviewer = await publish(url);
    assert.equal((await errorOf(reviewer)).code, "turn_not_yours");

    await send(url, key, [annotation]);
    await pollAndAck(url, key);
    const digestingNow = await errorOf(await publish(url));
    assert.equal(digestingNow.code, "turn_still_yours");
    assert.match(digestingNow.help[0]!, /lightspeed work/);

    await postWork(url, key, { plan: "fix", head: "head-1" });
    const unmoved = await publish(url, { headCommit: undefined });
    assert.equal(unmoved.status, 200, "a HEAD nobody named is not a HEAD that stood still");
  });
});

/** A resolved thread is closed: a refusal that suggests answering in it undoes the reviewer. */
test("a refusal names an open thread to answer in, never one the reviewer resolved", async () => {
  await withServer(async (running) => {
    const { url } = running;
    const key = await digesting(running);
    await postReply(url, key, { replies: [{ to: "t1", text: "done" }] });
    await send(url, key, [{ type: "resolve", thread: "t1", resolved: true }]);
    await pollAndAck(url, key);

    const refused = await errorOf(await publish(url));

    assert.equal(refused.code, "turn_still_yours");
    assert.match(refused.help.join("\n"), /--to t2 '<answer>'/);
    assert.doesNotMatch(refused.help.join("\n"), /--to t1/);
  });
});

test("publish on the HEAD of the last round is refused, naming reply", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await working(running);
    const head = store.get(key)!.rounds.at(-1)!.headCommit;
    assert.equal(head, undefined, "the fixture's first round names no head");
    await publish(url, { headCommit: "head-2" });
    await send(url, key, [message]);
    await pollAndAck(url, key);
    await postWork(url, key, { plan: "more" });

    const refused = await publish(url, { headCommit: "head-2", intents: ["again"] });

    assert.equal(refused.status, 422);
    const body = await errorOf(refused);
    assert.equal(body.code, "nothing_to_publish");
    assert.match(body.help[0]!, /lightspeed reply/);
  });
});

test("publish notes naming an unknown item are refused before the round opens", async () => {
  await withServer(async (running) => {
    const { url, store } = running;
    const key = await working(running);

    const response = await publish(url, { notes: [{ to: "t42", text: "done" }] });

    assert.equal((await errorOf(response)).code, "feedback_item_unknown");
    assert.equal(store.get(key)!.rounds.length, 1);
  });
});

test("publish on no session is a 404, and on an ended one a 409", async () => {
  await withServer(async ({ url }) => {
    assert.equal((await publish(url)).status, 404);
    const { key } = await postSession(url);
    await fetch(`${url}/api/session/${key}/end`, { method: "POST" });
    assert.equal((await publish(url)).status, 409);
  });
});

/** Finding 3: 2.x wrote queued words into the conversation too; they must reach the agent once. */
test("a real 2.x session re-attached under 3.0 hands over its batch, then its queue, each once", async () => {
  await withServer(async ({ url, store }) => {
    const fixture = new URL("./fixtures/sessions/v2-reading.json", import.meta.url);
    const v2 = JSON.parse(readFileSync(fixture, "utf8")) as SessionRecord;
    store.save(v2);

    const held = await pollAndAck(url, v2.key);
    const reviewerSaid = (items: unknown) =>
      (items as { reviewer: string[] }[]).map((item) => item.reviewer.join(" "));
    assert.deepEqual(reviewerSaid(held.items), ["why 2?", "general v2 q"]);

    const replied = await postReply(url, v2.key, {
      replies: [{ to: "t1", text: "answered" }],
    });
    assert.equal(replied.status, 200);
    const next = await pollAndAck(url, v2.key);
    assert.deepEqual(reviewerSaid(next.items), ["queued while reading", "queued line"]);
    assert.equal(store.get(v2.key)!.pending.length, 0);
  });
});
