/**
 * The column's folds: a card's, and the resolved group's. Folding is reading,
 * not writing, so none of this is locked — not by the turn, not by a send.
 * Each press writes its choice to the review's memory and reports whether it
 * changed anything; the mount redraws.
 */
import type { PanelState } from "../conversation-panel.ts";
import { updateMemory, type ReviewMemoryStorage } from "../review-memory.ts";
import { cardSettled, cardShut, groupCards } from "../thread-groups.ts";

interface FoldView {
  readonly state: PanelState;
  readonly options: { storage: ReviewMemoryStorage; key: string };
}

/**
 * Anywhere on a card's head: the press is walked up to the head's key. Asked
 * only after the head's own presses (the file jump), which must not fold too.
 */
export function foldPress(view: FoldView, target: HTMLElement): boolean {
  const key = target.closest<HTMLElement>("[data-fold]")?.dataset.fold;
  if (key === undefined) return false;
  const { state } = view;
  const card = groupCards(state.conversation)
    .flatMap((group) => group.cards)
    .find((one) => one.key === key);
  if (card === undefined) return false;
  const queued = queuedResolve(state.pending, card.id);
  const fold = { shut: !cardShut(card, queued, state.folds), resolved: cardSettled(card, queued) };
  state.folds = { ...state.folds, [key]: fold };
  updateMemory(view.options.storage, view.options.key, { folds: state.folds });
  return true;
}

/** The last queued toggle wins, as the card draws it. */
function queuedResolve(pending: PanelState["pending"], thread: string): boolean | undefined {
  const pill = pending.findLast((one) => one.type === "resolve" && one.thread === thread);
  return pill?.type === "resolve" ? pill.resolved : undefined;
}

/** The resolved group's fold, kept per review like a card's. */
export function groupPress(view: FoldView, target: HTMLElement): boolean {
  if (target.dataset.groupToggle !== "resolved") return false;
  view.state.resolvedShown = !view.state.resolvedShown;
  updateMemory(view.options.storage, view.options.key, {
    resolvedShown: view.state.resolvedShown,
  });
  return true;
}
