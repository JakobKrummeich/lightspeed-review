import { request as httpRequest } from "node:http";
import { ReviewError } from "../errors.ts";
import { holdSocketOpen } from "../hold-open.ts";
import { parseBody } from "./api-client.ts";
import { diagnosePort, reviewServerIsUp, type PortState } from "./server-address.ts";

export interface LongPollInput {
  url: string;
  /** Named in the 404 message; the poll is always about one session. */
  key?: string;
  /** Probed when a connection fails, to tell "gone" from "hiccup". */
  port: number;
  /** Waits between port probes after a failure. Injected by tests. */
  probeBackoffMs?: number[];
  /** First wait before reconnecting to a port that is still open. Injected by tests. */
  reconnectDelayMs?: number;
}

const RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 5_000;
/** Failures against an open port tolerated before `/health` must answer. Anything
 * can drop one connection; a port that keeps accepting and never answers is not a
 * review server, and waiting on it forever is the silent hang this prevents. */
const FAILURES_BEFORE_HEALTH_CHECK = 3;

/**
 * Waits for the reviewer. No client-side timer ends the wait: `fetch` is unusable —
 * undici caps a response at `headersTimeout` (5 min default) and rejects a poll the
 * reviewer just has not answered (measured: 300687ms, `UND_ERR_HEADERS_TIMEOUT`);
 * `node:http` with `agent: false` gives the request its own connection, timers off.
 * Broken connections are re-made as long as two checks keep saying the server is
 * there: the port accepts, and — from the third failure — `/health` answers. Ends
 * on the reviewer's answer, an unknown/ended session, or a port diagnosis: refused
 * is `server_not_running`, everything else `server_unreachable`.
 */
export async function longPoll(input: LongPollInput): Promise<unknown> {
  const retry = retries(input);
  for (;;) {
    try {
      return await pollOnce(input.url, input.key);
    } catch (error) {
      // An answer about the review (unknown session, ended, stopping) is final.
      if (error instanceof ReviewError) throw error;
      await retry(error);
    }
  }
}

/** After a broken connection: is there still a server to wait for — wait longer or
 * report the port. Failure count lives here so `longPoll` stays a plain loop. */
function retries(input: LongPollInput): (failure: unknown) => Promise<void> {
  let failures = 0;
  return async (failure: unknown) => {
    const state = await diagnosePort(input.port, input.probeBackoffMs);
    if (state !== "open") throw portIsNotServing(state, input.port, failure);
    failures += 1;
    if (failures >= FAILURES_BEFORE_HEALTH_CHECK && !(await reviewServerIsUp(input.port))) {
      throw notAReviewServer(input.port, failure);
    }
    await sleep(reconnectDelay(failures, input.reconnectDelayMs));
  };
}

/** Backs off to a probe every few seconds; a review takes as long as it takes. */
function reconnectDelay(failures: number, first: number | undefined): number {
  const base = first ?? RECONNECT_DELAY_MS;
  return Math.min(base * 2 ** (failures - 1), MAX_RECONNECT_DELAY_MS);
}

/** Only a port that refuses connections, and keeps refusing, is "no server". */
function portIsNotServing(state: PortState, port: number, failure: unknown): ReviewError {
  const detail = messageOf(failure);
  if (state === "refused") {
    return new ReviewError({
      code: "server_not_running",
      message: "no lightspeed server is listening",
      detail: `${detail}; nothing accepted a connection on port ${port}`,
      suggestions: ["Run `lightspeed start <branch> [base]` to start the review server"],
    });
  }
  return new ReviewError({
    code: "server_unreachable",
    message: `port ${port} neither accepted a connection nor refused one`,
    detail: `${detail}; the machine answered nothing at all on that port`,
    suggestions: [
      "Re-run `lightspeed poll <branch> [base]` in the foreground",
      "Run `lightspeed stop` and then `lightspeed start <branch> [base]` if it keeps failing",
    ],
  });
}

/** Something holds the port and it is not ours: waiting on it would never end. */
function notAReviewServer(port: number, failure: unknown): ReviewError {
  return new ReviewError({
    code: "server_unreachable",
    message: `port ${port} is held by something that is not a review server`,
    detail: `${messageOf(failure)}; the port accepts connections but /health does not answer`,
    suggestions: [
      `Set a free \`port\` in .lightspeed.conf.json instead of ${port}`,
      "Stop whatever is listening there and run `lightspeed start <branch> [base]` again",
    ],
  });
}

/** One attempt on a connection of its own, every timeout off: the server answers
 * when the reviewer sends, which may be hours. */
function pollOnce(url: string, key: string | undefined): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const request = httpRequest(
      url,
      // `connection: close` because this socket is used once; nothing may pool it.
      { agent: false, headers: { connection: "close" } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("error", fail);
        response.on("end", () => {
          const answer = parseBody(response.statusCode ?? 0, body, key);
          if (answer instanceof ReviewError) fail(answer);
          else resolve(answer);
        });
      },
    );
    // A half-open request left behind would hold the process open after failure handling.
    function fail(error: unknown): void {
      request.destroy();
      reject(error);
    }
    request.setTimeout(0);
    request.on("socket", holdSocketOpen);
    request.on("error", fail);
    request.end();
  });
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
