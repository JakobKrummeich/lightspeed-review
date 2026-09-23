import { changedFrom } from "../rounds/last-round-form.ts";
import type { RoundFile } from "../session-store.ts";

/**
 * Uses the server's own comparison (`changedFrom`, `src/rounds/last-round-form.ts`),
 * so the page never offers a `Since last round` press the server would refuse.
 * Switch precedence is not decided here: that rule lives only in `diff-view.ts`.
 */

/** `files` optional: `RoundMark`s carry none. */
interface RoundBlobs {
  files?: readonly RoundFile[];
}

export function changedSinceLastRound(rounds: readonly RoundBlobs[]): Set<string> {
  const current = rounds.at(-1)?.files;
  const previous = rounds.at(-2)?.files;
  if (current === undefined || previous === undefined) return new Set();
  return new Set(
    current.filter((file) => changedFrom(previous, file) !== undefined).map((file) => file.path),
  );
}
