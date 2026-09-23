/**
 * Every collection lives behind this class so handlers cannot mutate shared
 * transport state directly — half of presence is derived from the pollers, and
 * the other half is read off the stored turn.
 */
import type { ServerResponse } from "node:http";
import type { Turn } from "../session-store.ts";
import { sseFrame } from "./http.ts";

export type WakeReason = "feedback" | "shutdown";

/**
 * A parked poller. Answering takes what was queued, so it says whether it did:
 * the queue is one batch and it belongs to one agent.
 */
export type Waker = (reason: WakeReason) => boolean;

export type TurnReader = (key: string) => Turn | undefined;

export class SessionTransport {
  private readonly streams = new Map<string, Set<ServerResponse>>();
  private readonly pollers = new Map<string, Set<Waker>>();

  /**
   * The turn is session state, not transport state: it is read here rather than
   * held here so a `serve` restart publishes the lock the last run left, and so
   * no handler has to remember to announce a turn it just wrote.
   */
  private readonly turnOf: TurnReader;

  constructor(turnOf: TurnReader) {
    this.turnOf = turnOf;
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

  addPoller(key: string, wake: Waker): void {
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
   * that cannot — a poller whose connection died takes nothing. Stopping is the
   * whole of "whoever loses the race stays parked": a delivery is not spent
   * until the agent confirms it, so a second poller woken after the first would
   * otherwise be handed the batch that is still in flight to the first.
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
   * Two facts, and no third derived from them: `waiting` is a live connection
   * and can only be counted here, `turn` is read off the record so the banner
   * and the gate on Send cannot disagree about who holds the review. A dead
   * agent leaves the turn standing — indistinguishable from thinking hard, and
   * there is no heartbeat to tell them apart; recovery is out of band.
   */
  private presenceFrame(key: string): string {
    const turn = this.turnOf(key);
    return sseFrame("presence", {
      waiting: (this.pollers.get(key)?.size ?? 0) > 0,
      ...(turn === undefined ? {} : { turn }),
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
