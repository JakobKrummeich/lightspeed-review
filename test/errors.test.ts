import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewError, exitCodeFor, type ReviewErrorCode } from "../src/errors.ts";

function exitFor(code: ReviewErrorCode): number {
  return exitCodeFor(new ReviewError({ code, message: "m", suggestions: ["h"] }));
}

/**
 * One rule: exit 2 when retrying the same command cannot help — the command
 * line or the move was wrong, and `help[]` names the right one; exit 1 when the
 * world got in the way and the same command may work once it is fixed.
 */
test("every refusal of the move or of the session state exits 2", () => {
  const wrongState: ReviewErrorCode[] = [
    "turn_not_yours",
    "turn_still_yours",
    "nothing_to_publish",
    "feedback_item_unknown",
    "session_ended",
    "session_not_found",
    "ambiguous_session",
  ];

  assert.deepEqual(
    wrongState.map(exitFor),
    wrongState.map(() => 2),
  );
});

test("a failure of the machine, not of the command, exits 1", () => {
  const environment: ReviewErrorCode[] = [
    "server_not_running",
    "server_unreachable",
    "git_ref_not_found",
    "config_missing",
    "internal_error",
  ];

  assert.deepEqual(
    environment.map(exitFor),
    environment.map(() => 1),
  );
});
