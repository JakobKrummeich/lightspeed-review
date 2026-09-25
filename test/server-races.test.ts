/**
 * Two requests for one session, interleaved: a handler that read the session
 * before awaiting its body must not save that stale copy over what landed in
 * between.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotation,
  pollAndAck,
  postFeedback,
  postReply,
  postSession,
  slowPost,
  withServer,
} from "./helpers/review-server.ts";

const message = { type: "message", comment: "why a new table?" };

test("an approval whose body arrives late does not undo the reply that landed first", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postFeedback(url, key, { prompts: [annotation, message], ended: false });
    await pollAndAck(url, key);
    const approving = await slowPost(url, `/api/session/${key}/approved`, {
      approved: ["src/api/users.ts"],
    });

    const replied = await postReply(url, key, { replies: [{ to: "t2", text: "it is needed" }] });
    assert.equal(replied.status, 200);
    assert.equal((await approving.finish()).status, 200);

    const session = store.get(key)!;
    assert.equal(session.turn.holder, "reviewer", "the reply's handback survived");
    assert.deepEqual(session.approved, ["src/api/users.ts"]);
    assert.equal(session.conversation.at(-1)?.role, "agent");
  });
});

test("two Sends whose bodies interleave mint distinct thread ids and keep both", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    const slow = await slowPost(url, `/api/session/${key}/feedback`, {
      prompts: [message],
      ended: false,
    });

    await postFeedback(url, key, { prompts: [annotation], ended: false });
    assert.equal((await slow.finish()).status, 200);

    const ids = store.get(key)!.pending.map((prompt) => (prompt as { id?: string }).id);
    assert.deepEqual(ids, ["t1", "t2"]);
  });
});

test("a work whose body arrives late does not undo the approval that landed first", async () => {
  await withServer(async ({ url, store }) => {
    const { key } = await postSession(url);
    await postFeedback(url, key, { prompts: [message], ended: false });
    await pollAndAck(url, key);
    const working = await slowPost(url, `/api/session/${key}/work`, { plan: "split it" });

    await postApproved(url, key);
    assert.equal((await working.finish()).status, 200);

    const session = store.get(key)!;
    assert.deepEqual(session.approved, ["src/api/users.ts"]);
    assert.equal(session.turn.holder === "agent" && session.turn.mode, "working");
  });
});

async function postApproved(url: string, key: string): Promise<void> {
  const response = await fetch(`${url}/api/session/${key}/approved`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: ["src/api/users.ts"] }),
  });
  assert.equal(response.status, 200);
}
