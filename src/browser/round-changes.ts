import { changedFrom } from "../rounds/last-round-form.ts";
import type { RoundFile } from "../session-store.ts";

/**
 * Files provably edited since the round before — the `Since last round`
 * switch candidates. Uses the server's own comparison (`changedFrom`,
 * `src/rounds/last-round-form.ts`), so the page never offers a press the
 * server would refuse. Switch precedence is not decided here: that rule lives
 * only in `diff-view.ts`.
 */

/** The slice of a wire round this question reads. `RoundMark`s carry no files. */
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
