/**
 * The server's push transport: SSE streams to browser pages and long-poll
 * waiters per session. Every collection lives behind this class so handlers
 * cannot mutate shared transport state directly — half of presence is derived
 * from the pollers, and the half that cannot be is only set through a method.
 */
import type { ServerResponse } from "node:http";
import { sseFrame } from "./http.ts";

export type WakeReason = "feedback" | "shutdown";

export class SessionTransport {
  private readonly streams = new Map<string, Set<ServerResponse>>();
  /** Long-polling agents, woken when their session receives feedback or the server stops. */
  private readonly pollers = new Map<string, Set<(reason: WakeReason) => void>>();
  /**
   * Sessions whose feedback an agent took and has not answered. Not derivable
   * like waiting: a working agent is by definition not connected. A dead agent
   * leaves the flag standing — indistinguishable from thinking hard, and no
   * heartbeat to time out against; the next poll, reply, round or end clears it.
   */
  private readonly working = new Set<string>();

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

  /** Whether an agent is currently blocked in `poll` for this session. */
  publishPresence(key: string): void {
    for (const response of this.streams.get(key) ?? []) response.write(this.presenceFrame(key));
  }

  /**
   * Publishing is part of the change, not something callers remember: a flag no
   * page was told about would leave the banner saying something stale.
   */
  setWorking(key: string, working: boolean): void {
    if (working) this.working.add(key);
    else this.working.delete(key);
    this.publishPresence(key);
  }

  private presenceFrame(key: string): string {
    return sseFrame("presence", {
      waiting: (this.pollers.get(key)?.size ?? 0) > 0,
      working: this.working.has(key),
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
