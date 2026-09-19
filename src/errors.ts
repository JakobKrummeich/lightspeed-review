import { AxiError, exitCodeForError } from "axi-sdk-js";

/**
 * Every failure the CLI can report. Keeping the set closed means an error code
 * is greppable and `output.ts` never has to guess how to render one.
 */
export type ReviewErrorCode =
  | "config_missing"
  | "config_invalid"
  | "git_ref_not_found"
  | "git_repo_not_found"
  | "pi_model_unknown"
  | "pi_auth_missing"
  | "pi_auth_failed"
  | "login_unsupported"
  | "login_needs_terminal"
  | "login_failed"
  | "pi_stream_failed"
  | "ledger_disabled"
  | "ledger_unwritable"
  | "feedback_item_unknown"
  | "session_corrupt"
  | "session_not_found"
  | "session_ended"
  | "declaration_invalid"
  | "turn_not_yours"
  | "turn_still_yours"
  | "ambiguous_session"
  | "unknown_command"
  | "unknown_flag"
  | "argument_missing"
  | "invalid_arguments"
  | "intent_missing"
  | "agent_missing"
  | "server_not_running"
  | "server_unreachable"
  | "server_already_running"
  | "port_unavailable"
  | "browser_bundle_missing"
  | "internal_error";

export interface ReviewErrorInput {
  code: ReviewErrorCode;
  message: string;
  /** Extra context shown under `error.detail`, e.g. the set of valid values. */
  detail?: string;
  /** Next-step command templates rendered as `help[]`. At least one, always. */
  suggestions: [string, ...string[]];
}

/**
 * AxiError plus a `detail` line, matching the spec's error payload shape
 * `error: {code, message, detail}` + `help[]`.
 */
export class ReviewError extends AxiError {
  readonly detail: string | undefined;

  constructor(input: ReviewErrorInput) {
    super(input.message, input.code, input.suggestions);
    this.name = "ReviewError";
    this.detail = input.detail;
  }
}

/**
 * The three ways the command line itself can be wrong, and the recovery each
 * one asks for: look the command up, look the flag up, supply what was left
 * out. They used to share the SDK's `VALIDATION_ERROR`, which made an agent
 * that branches on `error.code` re-read the message text to find out which of
 * the three it had done — the one thing a code is for. `cli.ts` exits 2 on
 * them, the way the SDK exits 2 on its own.
 */
export type InvocationErrorCode = "unknown_command" | "unknown_flag" | "argument_missing";

export function invocationError(
  code: InvocationErrorCode,
  message: string,
  suggestions: [string, ...string[]],
  detail?: string,
): ReviewError {
  return new ReviewError({
    code,
    message,
    suggestions,
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * Exit 2 = "the command line was wrong". The SDK knows only its own
 * `VALIDATION_ERROR`, so the codes that mean the same thing are listed here,
 * beside the codes themselves rather than in the CLI entry point — which runs
 * the whole CLI on import and so cannot be asked what an error would exit with.
 */
const ARGUMENT_ERROR_CODES: readonly string[] = [
  "unknown_command",
  "unknown_flag",
  "argument_missing",
  "invalid_arguments",
  "intent_missing",
  "agent_missing",
  // A move made out of turn is a wrong command line like any other: the fixing
  // command is in the error's own `help[]`, and exit 2 says "read it, don't retry".
  "turn_not_yours",
  // Waiting while still holding the turn is the same mistake from the other end.
  "turn_still_yours",
];

export function exitCodeFor(error: unknown): number {
  if (error instanceof ReviewError && ARGUMENT_ERROR_CODES.includes(error.code)) return 2;
  return exitCodeForError(error);
}
