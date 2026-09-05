import { crossings } from "../approval-crossing.ts";
import { mountDonePopup } from "./done-popup.ts";
import type { MountedPanel } from "./panel-mount.ts";
import type { MountedRail } from "./panel-rail.ts";

/** The panel column's two parts the finish speaks to, once they are built. */
export interface FinishSide {
  railControl: MountedRail;
  panel: MountedPanel;
}

/**
 * Where the diff's approval reports go: the panel's note, the rail on the
 * crossing, and the finish card with its end press. The diff draws first and
 * the panel column after, so until `attach` a report is only remembered; the
 * first report is never a crossing (see the module), so nothing is asked of a
 * column that is not there yet. The queue's size is kept because ending from
 * the card sends the queue, and the card says so.
 */
export function wireFinish(root: HTMLElement): {
  onApproved(complete: boolean): void;
  setQueued(count: number): void;
  attach(side: FinishSide): void;
} {
  let side: FinishSide | undefined;
  let allApproved = false;
  let queued = 0;
  const done = mountDonePopup({ root, onEnd: () => side?.panel.end() });
  const onCrossing = crossings(() => {
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
    attach: (built) => {
      side = built;
      // The report from before the panel existed; every later one goes straight through.
      built.panel.setAllApproved(allApproved);
    },
  };
}
