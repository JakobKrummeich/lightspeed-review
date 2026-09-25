/**
 * Every collection lives behind this class so handlers cannot mutate shared
 * transport state directly — half of presence is derived from the pollers, and
 * the other half is read off the stored turn.
 */
import type { ServerResponse } from "node:http";
import type { PresenceFacts } from "../turn.ts";
import { sseFrame } from "./http.ts";

export type WakeReason = "feedback" | "shutdown" | "superseded";

/**
 * A parked poller. Answering takes what was queued, so it says whether it did:
 * the queue is one batch and it belongs to one agent.
 */
export type Waker = (reason: WakeReason) => boolean;

export type PresenceReader = (key: string) => PresenceFacts | undefined;

export class SessionTransport {
  private readonly streams = new Map<string, Set<ServerResponse>>();
  private readonly pollers = new Map<string, Set<Waker>>();

  /**
   * The turn is session state, not transport state: it is read here rather than
   * held here so a `serve` restart publishes the lock the last run left, and so
   * no handler has to remember to announce a turn it just wrote.
   */
  private readonly presenceOf: PresenceReader;

  constructor(presenceOf: PresenceReader) {
    this.presenceOf = presenceOf;
  }

  subscribe(key: string, response: ServerResponse): void {
    const listeners = this.streams.get(key) ?? new Set<ServerResponse>();
    listeners.add(response);
    // A page that connects mid-poll would otherwise show "no agent" until the
    // next transition, so the current state is sent before any event.
    response.write(this.presenceFrame(key));
    this.streams.set(key, listeners);
  }

  unsubscribe(key: string, response: ServerResponse): void {
    this.streams.get(key)?.delete(response);
  }

  /**
   * The newest poll wins: every poller already parked on the session is
   * answered `superseded` first. An agent that re-ran its waiting command left
   * the old one behind — a background job, a harness that lost track of it —
   * and that orphan would otherwise take the next batch into a terminal nobody
   * reads, leaving the agent digesting nothing and the reviewer locked out.
   */
  addPoller(key: string, wake: Waker): void {
    for (const older of [...(this.pollers.get(key) ?? [])]) older("superseded");
    const waiting = this.pollers.get(key) ?? new Set<Waker>();
    waiting.add(wake);
    this.pollers.set(key, waiting);
  }

  removePoller(key: string, wake: Waker): void {
    this.pollers.get(key)?.delete(wake);
  }

  /**
   * Copied first: a woken poller removes itself from the set as it answers. The
   * loop stops at the one that takes the feedback, and goes on past the ones
   * that cannot — a poller whose connection died takes nothing. `addPoller`
   * keeps at most one live poller per session, so the loop is a guard, not a
   * race: a delivery is not spent until the agent confirms it, and a second
   * poller must never be handed the batch still in flight to the first.
   */
  wakePollers(key: string): void {
    for (const wake of [...(this.pollers.get(key) ?? [])]) {
      if (wake("feedback")) return;
    }
  }

  publish(key: string, event: string, data: unknown): void {
    for (const response of this.streams.get(key) ?? []) response.write(sseFrame(event, data));
  }

  publishPresence(key: string): void {
    for (const response of this.streams.get(key) ?? []) response.write(this.presenceFrame(key));
  }

  /**
   * Two facts, and nothing derived from them: `waiting` is a live connection
   * and can only be counted here, `turn` (with the batch size while the agent
   * digests) is read off the record so the banner and the lock on Send cannot
   * disagree about who holds the review. A dead
   * agent leaves the turn standing — indistinguishable from thinking hard, and
   * there is no heartbeat to tell them apart; recovery is out of band.
   */
  private presenceFrame(key: string): string {
    return sseFrame("presence", {
      waiting: (this.pollers.get(key)?.size ?? 0) > 0,
      ...this.presenceOf(key),
    });
  }

  watcherCount(): number {
    return [...this.streams.values(), ...this.pollers.values()].reduce(
      (total, set) => total + set.size,
      0,
    );
  }

  closeAll(): void {
    for (const waiting of this.pollers.values()) {
      for (const wake of [...waiting]) wake("shutdown");
      waiting.clear();
    }
    for (const listeners of this.streams.values()) {
      for (const response of listeners) response.end();
      listeners.clear();
    }
  }
}
