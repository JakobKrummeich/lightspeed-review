import { AxiError, exitCodeForError } from "axi-sdk-js";

/** Closed so an error code is greppable and `output.ts` never has to guess how to render one. */
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
  | "nothing_to_publish"
  | "removed_verb"
  | "turn_not_yours"
  | "turn_still_yours"
  | "agent_holds_turn"
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
  | "server_stale"
  | "server_state_mismatch"
  | "port_unavailable"
  | "browser_bundle_missing"
  | "internal_error";

export interface ReviewErrorInput {
  code: ReviewErrorCode;
  message: string;
  detail?: string;
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
 * Three codes rather than the SDK's one `VALIDATION_ERROR`: an agent that
 * branches on `error.code` should not have to re-read the message text to find
 * out which of the three it had done.
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
 * One rule: exit 2 when re-running the same command cannot help — the command
 * line was wrong, or the move was wrong for the session's state, and `help[]`
 * names the command that is right. Exit 1 when the world got in the way (a
 * server, git, a model, a config) and the same command may work once that is
 * fixed. The SDK knows only its own `VALIDATION_ERROR`, so the codes are listed
 * here, beside the codes themselves rather than in the CLI entry point — which
 * runs the whole CLI on import and so cannot be asked what an error would exit
 * with.
 */
const ARGUMENT_ERROR_CODES: readonly string[] = [
  // The command line itself.
  "unknown_command",
  "unknown_flag",
  "argument_missing",
  "invalid_arguments",
  "intent_missing",
  "agent_missing",
  // A 2.x verb: the command line is wrong for this version.
  "removed_verb",
  // The move, for the turn: out of turn, or still holding it.
  "turn_not_yours",
  "turn_still_yours",
  "nothing_to_publish",
  "feedback_item_unknown",
  // The move, for the session: over, never opened, or not the one named.
  "session_ended",
  "session_not_found",
  "ambiguous_session",
];

export function exitCodeFor(error: unknown): number {
  if (error instanceof ReviewError && ARGUMENT_ERROR_CODES.includes(error.code)) return 2;
  return exitCodeForError(error);
}
