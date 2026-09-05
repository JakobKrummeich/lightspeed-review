import { AxiError } from "axi-sdk-js";

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
  | "ambiguous_session"
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
 * Malformed invocations use the SDK's own `VALIDATION_ERROR` — the one code
 * `exitCodeForError` turns into exit 2 — so our exit codes match the SDK's.
 */
export function validationError(message: string, suggestions: [string, ...string[]]): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}
