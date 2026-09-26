import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELIVERY_LABEL,
  deliveryFacts,
  deliveryOf,
  handedOnTurn,
} from "../../src/browser/delivery.ts";
import type { FeedbackPrompt, Turn } from "../../src/session-store.ts";

const message: FeedbackPrompt = { type: "message", comment: "rename it" };
const REVIEWERS: Turn = { holder: "reviewer", at: "2025-01-01T00:10:00.000Z" };
const DIGESTING: Turn = { holder: "agent", mode: "digesting", at: "2025-01-01T00:20:00.000Z" };
const batch = { id: "b1", prompts: [message], at: "2025-01-01T00:05:00.000Z" };

test("words sent before the agent last picked up a batch were seen by it", () => {
  const facts = deliveryFacts({ batch, pending: [message], turn: REVIEWERS });

  assert.equal(deliveryOf("2025-01-01T00:04:00.000Z", facts, "feedback"), "seen");
  assert.equal(deliveryOf("2025-01-01T00:05:00.000Z", facts, "feedback"), "seen");
});

test("words sent after the last pickup, still held by the server, wait for a listener", () => {
  const facts = deliveryFacts({ batch, pending: [message], turn: REVIEWERS });

  assert.equal(deliveryOf("2025-01-01T00:06:00.000Z", facts, "feedback"), "unheard");
  assert.equal(DELIVERY_LABEL.unheard, "sent · agent not listening");
});

test("nothing held by the server means everything sent was handed over", () => {
  // Sessions from before batches were written down have none, and must not read as unheard.
  const facts = deliveryFacts({ pending: [], turn: REVIEWERS });

  assert.equal(deliveryOf("2025-01-01T00:06:00.000Z", facts, "feedback"), "seen");
});

test("an ended review claims no listener it never had: unheard words read as plainly sent", () => {
  const facts = deliveryFacts({ batch, pending: [message], turn: REVIEWERS });

  assert.equal(deliveryOf("2025-01-01T00:06:00.000Z", facts, "ended"), "sent");
  assert.equal(DELIVERY_LABEL.sent, "sent");
  assert.equal(DELIVERY_LABEL.seen, "✓ seen by agent");
});

test("a digesting turn is a pickup even before the session with its batch arrives", () => {
  const facts = handedOnTurn(
    deliveryFacts({ batch, pending: [message], turn: REVIEWERS }),
    DIGESTING,
  );

  assert.equal(deliveryOf("2025-01-01T00:19:00.000Z", facts, "feedback"), "seen");
});

test("a turn that is not a pickup leaves the facts as they were", () => {
  const facts = deliveryFacts({ batch, pending: [message], turn: DIGESTING });
  const working: Turn = { holder: "agent", mode: "working", at: "2025-01-01T00:30:00.000Z" };

  assert.deepEqual(handedOnTurn(facts, working), facts);
  assert.deepEqual(handedOnTurn(facts, REVIEWERS), facts);
  assert.equal(facts.handedAt, DIGESTING.at, "the later of batch and digesting turn");
});
