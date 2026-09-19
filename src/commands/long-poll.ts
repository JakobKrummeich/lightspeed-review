import { request as httpRequest } from "node:http";
import { ReviewError } from "../errors.ts";
import { holdSocketOpen } from "../hold-open.ts";
import { apiRequest, jsonPost, parseBody, type SessionRef } from "./api-client.ts";
import { startCall } from "./home.ts";
import { diagnosePort, reviewServerIsUp, type PortState } from "./server-address.ts";

export interface LongPollInput {
  /** `http://127.0.0.1:<port>`; both the poll and its acknowledgement hang off it. */
  origin: string;
  /** The session waited on, named in the 404 message and in both URLs. */
  key: string;
  /** `<branch> <base>`, for the commands an error about this review suggests. */
  target?: string;
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
      const answer = await pollOnce(`${input.origin}/api/poll?key=${input.key}`, about(input));
      await confirmDelivery(input, answer);
      return answer;
    } catch (error) {
      // An answer about the review (unknown session, ended, stopping) is final.
      if (error instanceof ReviewError) throw error;
      await retry(error);
    }
  }
}

/**
 * Tells the server the handover arrived. The server cannot see this for itself:
 * the bytes reach the kernel whether or not anything reads them, so without the
 * acknowledgement it must assume every delivery may have been lost. One place
 * for both blocking commands — `wait` and `ask` come through here.
 *
 * Best effort, because the prompts are already in this process's hands: a
 * failed acknowledgement costs one re-delivery on the next poll, while a failed
 * `wait` would cost the agent the feedback it is holding.
 */
async function confirmDelivery(input: LongPollInput, answer: unknown): Promise<void> {
  if (typeof answer !== "object" || answer === null) return;
  const { delivery } = answer as { delivery?: unknown };
  if (typeof delivery !== "string") return;
  try {
    await apiRequest(
      `${input.origin}/api/session/${input.key}/delivered`,
      jsonPost({ delivery }),
      about(input),
    );
  } catch {
    // The next poll re-delivers; nothing here is worth failing the wait over.
  }
}

/** After a broken connection: is there still a server to wait for — wait longer or
 * report the port. Failure count lives here so `longPoll` stays a plain loop. */
function retries(input: LongPollInput): (failure: unknown) => Promise<void> {
  let failures = 0;
  return async (failure: unknown) => {
    const named = input.target ?? "<branch> [base]";
    const state = await diagnosePort(input.port, input.probeBackoffMs);
    if (state !== "open") throw portIsNotServing(state, input.port, failure, named);
    failures += 1;
    if (failures >= FAILURES_BEFORE_HEALTH_CHECK && !(await reviewServerIsUp(input.port))) {
      throw notAReviewServer(input.port, failure, named);
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
function portIsNotServing(
  state: PortState,
  port: number,
  failure: unknown,
  target: string,
): ReviewError {
  const detail = messageOf(failure);
  if (state === "refused") {
    return new ReviewError({
      code: "server_not_running",
      message: "no lightspeed server is listening",
      detail: `${detail}; nothing accepted a connection on port ${port}`,
      suggestions: [`Run \`${startCall(target)}\` to start the review server`],
    });
  }
  return new ReviewError({
    code: "server_unreachable",
    message: `port ${port} neither accepted a connection nor refused one`,
    detail: `${detail}; the machine answered nothing at all on that port`,
    suggestions: [
      `Re-run \`lightspeed wait ${target}\` in the foreground`,
      `Run \`lightspeed stop\` and then \`${startCall(target)}\` if it keeps failing`,
    ],
  });
}

/** Something holds the port and it is not ours: waiting on it would never end. */
function notAReviewServer(port: number, failure: unknown, target: string): ReviewError {
  return new ReviewError({
    code: "server_unreachable",
    message: `port ${port} is held by something that is not a review server`,
    detail: `${messageOf(failure)}; the port accepts connections but /health does not answer`,
    suggestions: [
      `Set a free \`port\` in .lightspeed.conf.json instead of ${port}`,
      `Stop whatever is listening there and run \`${startCall(target)}\` again`,
    ],
  });
}

/** One attempt on a connection of its own, every timeout off: the server answers
 * when the reviewer sends, which may be hours. */
function about(input: LongPollInput): SessionRef {
  return { key: input.key, ...(input.target === undefined ? {} : { target: input.target }) };
}

function pollOnce(url: string, ref: SessionRef): Promise<unknown> {
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
          const answer = parseBody(response.statusCode ?? 0, body, ref);
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
