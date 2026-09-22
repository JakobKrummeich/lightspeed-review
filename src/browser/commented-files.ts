import type { DiffFile } from "../diff-extract.ts";
import { renamedFrom } from "../file-relocation.ts";
import type { ConversationEntry, RoundMark } from "../session-store.ts";
import { roundOf } from "./conversation-rounds.ts";

/**
 * Paths annotated in the round before the one on screen — the files this round
 * answers. Only annotations (general messages have no row); only the round
 * immediately before (older comments would be noise). The round comes from the
 * marks themselves, not current-index-minus-one: marks are what `roundOf`
 * places entries against, so the two cannot disagree. First round: empty set.
 */
export function commentedLastRound(
  conversation: readonly ConversationEntry[],
  rounds: readonly RoundMark[],
): Set<string> {
  const previous = rounds.at(-2)?.index;
  if (previous === undefined) return new Set();
  return new Set(
    conversation
      .filter((entry) => entry.role === "reviewer" && roundOf(entry, rounds) === previous)
      .flatMap((entry) => entry.prompts)
      .filter((prompt) => prompt.type === "annotation")
      .map((prompt) => prompt.file),
  );
}

/**
 * Whether this row is one of them. A rename's old name is tried too, but that
 * is git's rename since the merge base (`diff-extract.ts`), not what last round
 * called the file — so some renames lose the badge. Left partial on purpose:
 * following renames through rounds is `fileHistory` in `rounds/history.ts`,
 * which needs the whole `SessionRound[]` — not worth sending to the browser.
 * An earlier name on any other status is not tried (`renamedFrom`): that file
 * is still on the page, wearing the badge itself.
 */
export function commentedOn(file: DiffFile, commented: ReadonlySet<string>): boolean {
  if (commented.has(file.path)) return true;
  const earlierName = renamedFrom(file);
  return earlierName !== undefined && commented.has(earlierName);
}
