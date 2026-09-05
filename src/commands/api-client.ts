import { ReviewError } from "../errors.ts";
import { diagnosePort } from "./server-address.ts";

/** Talks to the review server for a command, mapping transport failures to codes
 * an agent can act on — no command interprets an HTTP status itself. */
export async function apiRequest(
  url: string,
  init?: RequestInit,
  /** Named in the 404 message when the request is about one session. */
  key?: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await sendOnce(url, init);
  } catch (error) {
    throw await transportError(url, error);
  }
  const answer = parseBody(response.status, await response.text(), key);
  if (answer instanceof ReviewError) throw answer;
  return answer;
}

/** Statuses about the review rather than HTTP. Reached through `parseBody`, so
 * every client names them the same. */
function errorForStatus(status: number, key?: string): ReviewError | undefined {
  if (status === 404) {
    return new ReviewError({
      code: "session_not_found",
      message:
        key === undefined ? "the review server knows no such session" : `no review session ${key}`,
      suggestions: ["Run `lightspeed start <branch> [base]` to open the session first"],
    });
  }
  if (status === 409) {
    return new ReviewError({
      code: "session_ended",
      message: "the reviewer ended this review; only they ask for a new round",
      suggestions: [
        "Run `lightspeed start <branch> [base] --reopen` once the reviewer asks for one",
      ],
    });
  }
  if (status === 503) {
    return new ReviewError({
      code: "server_not_running",
      message: "the review server shut down while the command was waiting",
      suggestions: ["Run `lightspeed start <branch> [base]` to restart the review server"],
    });
  }
  return undefined;
}

/** The payload, or the error the status and body add up to. Shared with the long
 * poll, which reads the same statuses off its own connection — the two clients
 * must not drift on what a 500 or a non-JSON body means. */
export function parseBody(status: number, body: string, key?: string): unknown {
  const failure = errorForStatus(status, key);
  if (failure) return failure;
  if (status === 422) return domainError(body);
  if (status < 200 || status > 299) {
    return new ReviewError({
      code: "internal_error",
      message: `the review server answered ${status}`,
      detail: body.slice(0, 200),
      suggestions: ["Re-run the command; if it persists this is a lightspeed bug"],
    });
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return new ReviewError({
      code: "internal_error",
      message: "the review server answered with something that is not JSON",
      detail: body.slice(0, 200),
      suggestions: ["Re-run the command; if it persists this is a lightspeed bug"],
    });
  }
}

/** 422 is the server rejecting the request's content (today, a declaration) with a
 * structured error relayed as it stands — the server is the one place the rules are
 * spelt. A 422 whose body is not that shape is a bug. */
function domainError(body: string): ReviewError {
  const parsed = readErrorBody(body);
  const { code, message, detail } = parsed.error ?? {};
  if (code !== "declaration_invalid" || typeof message !== "string") {
    return new ReviewError({
      code: "internal_error",
      message: "the review server answered 422 without a readable error",
      detail: body.slice(0, 200),
      suggestions: ["Re-run the command; if it persists this is a lightspeed bug"],
    });
  }
  const help = Array.isArray(parsed.help)
    ? parsed.help.filter((line): line is string => typeof line === "string")
    : [];
  return new ReviewError({
    code,
    message,
    ...(typeof detail === "string" ? { detail } : {}),
    suggestions: [help[0] ?? "Fix the declaration and re-send the whole reply", ...help.slice(1)],
  });
}

type ErrorBody = {
  error?: { code?: unknown; message?: unknown; detail?: unknown };
  help?: unknown;
};

function readErrorBody(body: string): ErrorBody {
  try {
    return JSON.parse(body) as ErrorBody;
  } catch {
    return {};
  }
}

/** A failed request is not a diagnosis: only a refused connection proves nothing is
 * listening, and calling anything else "no server" sends the agent to restart a
 * running one. The port is probed the same retried way the long poll probes it, so
 * one command cannot call a port dead the other still waits on. */
export async function transportError(url: string, error: unknown): Promise<ReviewError> {
  const port = portOf(url);
  const detail = failureDetail(error);
  if ((await diagnosePort(port)) === "refused") {
    return new ReviewError({
      code: "server_not_running",
      message: "no lightspeed server is listening",
      detail: `${detail}; nothing accepts a connection on port ${port}`,
      suggestions: ["Run `lightspeed start <branch> [base]` to start the review server"],
    });
  }
  return new ReviewError({
    code: "server_unreachable",
    message: `the review server on port ${port} did not answer the request`,
    detail: `${detail}; the port is still reachable, so the server is there`,
    suggestions: [
      "Re-run the command; the connection failed, not the review",
      "Run `lightspeed stop` and then `lightspeed start <branch> [base]` if it keeps failing",
    ],
  });
}

/** `fetch` reports every transport failure as "fetch failed"; the real cause is on
 * `cause`. A bare "fetch failed" once cost an hour, so the cause travels with it. */
function failureDetail(error: unknown): string {
  const message = (error as Error).message;
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const because = cause?.code ?? cause?.message;
  return because === undefined ? message : `${message} (${because})`;
}

function portOf(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? 443 : 80);
}

const RETRY_DELAY_MS = 50;

/** One retry for a read whose connection failed. Undici already retries a pooled
 * socket closed under it; this is insurance beyond that, never shown to save a
 * specific failure. Only reads retry: a dropped POST may have landed, and a
 * duplicated reply is worse than an error the agent can act on. */
async function sendOnce(url: string, init: RequestInit | undefined): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (!isRetryable(init)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return await fetch(url, init);
  }
}

function isRetryable(init: RequestInit | undefined): boolean {
  const method = init?.method ?? "GET";
  return method === "GET";
}

export function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
