/**
 * The server's push transport: SSE streams to browser pages and long-poll
 * waiters per session. Every collection lives behind this class so handlers
 * cannot mutate shared transport state directly — half of presence is derived
 * from the pollers, and the other half is read off the stored turn.
 */
import type { ServerResponse } from "node:http";
import type { Turn } from "../session-store.ts";
import { sseFrame } from "./http.ts";

export type WakeReason = "feedback" | "shutdown";

/** The stored turn of one session, or none when no such session is on disk. */
export type TurnReader = (key: string) => Turn | undefined;

export class SessionTransport {
  private readonly streams = new Map<string, Set<ServerResponse>>();
  /** Long-polling agents, woken when their session receives feedback or the server stops. */
  private readonly pollers = new Map<string, Set<(reason: WakeReason) => void>>();

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

  /** Several agents may wait on one session; each is parked under its wake call. */
  addPoller(key: string, wake: (reason: WakeReason) => void): void {
    const waiting = this.pollers.get(key) ?? new Set<(reason: WakeReason) => void>();
    waiting.add(wake);
    this.pollers.set(key, waiting);
  }

  removePoller(key: string, wake: (reason: WakeReason) => void): void {
    this.pollers.get(key)?.delete(wake);
  }

  /** Copied first: a woken poller removes itself from the set as it answers. */
  wakePollers(key: string): void {
    for (const wake of [...(this.pollers.get(key) ?? [])]) wake("feedback");
  }

  /** Pushes an SSE event to every browser watching one session. */
  publish(key: string, event: string, data: unknown): void {
    for (const response of this.streams.get(key) ?? []) response.write(sseFrame(event, data));
  }

  /** Who is on the review now: a waiter on the wire, and whose turn it is. */
  publishPresence(key: string): void {
    for (const response of this.streams.get(key) ?? []) response.write(this.presenceFrame(key));
  }

  /**
   * `waiting` is a live connection and can only be counted here; `working` is
   * derived from the turn rather than tracked beside it, so the banner and the
   * gate on Send can never disagree about who holds the review. A dead agent
   * leaves the turn standing — indistinguishable from thinking hard, and there
   * is no heartbeat to tell them apart; recovery is out of band.
   */
  private presenceFrame(key: string): string {
    const turn = this.turnOf(key);
    return sseFrame("presence", {
      waiting: (this.pollers.get(key)?.size ?? 0) > 0,
      working: turn?.holder === "agent",
      ...(turn === undefined ? {} : { turn }),
    });
  }

  /** Open streams plus parked pollers. */
  watcherCount(): number {
    return [...this.streams.values(), ...this.pollers.values()].reduce(
      (total, set) => total + set.size,
      0,
    );
  }

  /** Shutdown: every poller is told the wait is over, every stream is ended. */
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
