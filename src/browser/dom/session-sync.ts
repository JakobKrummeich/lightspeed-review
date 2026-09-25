/**
 * The bookkeeping behind keeping an open page level with the server, pure so it
 * tests without a stream: which answer may draw, whether it is news, and how
 * long a dead stream waits. The wiring is `session-events.ts`.
 */
import { currentRound } from "../conversation-rounds.ts";
import type { SessionData } from "./session-api.ts";

/**
 * "announced": the server published a `session` event. "opened": the stream
 * (re)connected, and whatever was published while it was down is gone.
 */
export type SyncCause = "announced" | "opened";

export interface SyncAsks {
  /** Numbers a fetch as it goes out. */
  send(cause: SyncCause): number;
  /**
   * Undefined: a newer answer has landed already and this one would put older
   * state back. Otherwise the cause the answer stands for.
   */
  land(ask: number): SyncCause | undefined;
}

/**
 * Asks answer out of order. Only an answer older than one already landed is
 * dropped — not one merely overtaken by a newer ask, which may yet fail. An
 * answer stands for every ask up to its own, so an announcement among them is
 * carried: an "opened" answer landing first must not let the skip for unchanged
 * sessions swallow what the server announced.
 */
export function createSyncAsks(): SyncAsks {
  let sent = 0;
  let landed = 0;
  const announced = new Set<number>();
  return {
    send(cause) {
      sent += 1;
      if (cause === "announced") announced.add(sent);
      return sent;
    },
    land(ask) {
      if (ask < landed) return undefined;
      landed = ask;
      let carried = false;
      for (const each of announced) {
        if (each > ask) continue;
        carried = true;
        announced.delete(each);
      }
      return carried ? "announced" : "opened";
    },
  };
}

/**
 * What `applyRound` draws that can move while a page is open, reduced to
 * compare cheaply. The round is named by its opening time as well as its
 * number: a session deleted and started again (`session_corrupt` recovery)
 * reopens at round 0 with a different diff. Intents, commits, groups and round
 * files are left out: they only change with a new round (every `open` and
 * `publish` makes one). Approvals too: the page is their only writer, so the server's copy
 * trails the ticks on screen and would read as news after every tick. The
 * turn is presence's.
 */
export function shownOf(session: SessionData): string {
  const last = session.conversation.at(-1);
  return JSON.stringify({
    round: currentRound(session.rounds),
    opened: session.rounds.at(-1)?.at,
    status: session.status,
    endedBy: session.endedBy,
    talk: [session.conversation.length, last?.role, last?.at],
  });
}

/**
 * A reopened stream's answer is drawn only past what is on screen: an SSH
 * tunnel drops idle streams, and a same-round redraw shuts the intent block
 * and drops the diff's selection and the answer box's caret. An announced
 * answer is drawn regardless — the server said something moved, and `shownOf`
 * is a reduction.
 */
export function isNews(cause: SyncCause, fresh: SessionData, drawn: SessionData): boolean {
  return cause === "announced" || shownOf(fresh) !== shownOf(drawn);
}

/**
 * The feedback handler draws the panel and the banner, not the round: only
 * what they show is counted as drawn. Otherwise an answer carrying a new round
 * (published while the stream was down) would be counted as on screen, and the
 * reopen's own answer skipped as old news. An ended status is left out as
 * well: `applyRound` has more to do for it (the replay's reopen control).
 */
export function drawnAfterFeedback(drawn: SessionData, fresh: SessionData): SessionData {
  return {
    ...drawn,
    conversation: fresh.conversation,
    ...(fresh.status === "ended" ? {} : { status: fresh.status }),
  };
}

/**
 * How long a stream the browser gave up on waits before a new one, doubling
 * while the server keeps refusing. Native EventSource retries by itself (~3s)
 * after a drop, but not after a non-200 answer (a 500 on an unreadable session
 * file): that stream is closed for good.
 */
export const REOPEN_MS = 5000;
export const REOPEN_MAX_MS = 60_000;

export function nextReopenDelay(delay: number): number {
  return Math.min(delay * 2, REOPEN_MAX_MS);
}
