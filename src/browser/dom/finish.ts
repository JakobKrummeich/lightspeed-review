import { crossings } from "../approval-crossing.ts";
import type { Turn } from "../../session-store.ts";
import { mountDonePopup } from "./done-popup.ts";
import type { MountedPanel } from "./panel-mount.ts";
import type { MountedRail } from "./panel-rail.ts";

export interface FinishSide {
  railControl: MountedRail;
  panel: MountedPanel;
}

/**
 * The diff draws first and the panel column after, so until `attach` a report
 * is only remembered; the first report is never a crossing (see the module),
 * so nothing is asked of a column that is not there yet. The queue's size is
 * kept because ending from the card sends the queue, and the card says so.
 *
 * The card is the answer to the reviewer approving the last file while the
 * agent is listening — nothing else. A crossing on the agent's turn is spent,
 * not deferred: the agent coming back (from `digesting` it changed no file)
 * is not the reviewer finishing, so the turn's return never opens the card.
 * `opening` is the session's own turn, so a page loaded mid-work is not
 * treated as the reviewer's until SSE says otherwise.
 */
export function wireFinish(
  root: HTMLElement,
  opening: Turn,
): {
  onApproved(complete: boolean): void;
  setQueued(count: number): void;
  setTurn(turn: Turn): void;
  attach(side: FinishSide): void;
} {
  let side: FinishSide | undefined;
  let allApproved = false;
  let queued = 0;
  let listening = opening.holder === "reviewer";
  const done = mountDonePopup({ root, onEnd: () => side?.panel.end() });
  const onCrossing = crossings(() => {
    if (!listening) return;
    side?.railControl.expand();
    done.open(queued);
  });
  return {
    onApproved: (complete) => {
      allApproved = complete;
      side?.panel.setAllApproved(complete);
      onCrossing(complete);
      // A finish that came undone — a round took the page, a box came unticked
      // in another tab — takes its card with it.
      if (!complete) done.close();
    },
    setQueued: (count) => {
      queued = count;
    },
    setTurn: (turn) => {
      listening = turn.holder === "reviewer";
      if (!listening) done.close();
    },
    attach: (built) => {
      side = built;
      // The report from before the panel existed; every later one goes straight through.
      built.panel.setAllApproved(allApproved);
    },
  };
}
