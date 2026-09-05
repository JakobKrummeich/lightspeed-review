import type { DiffRenderer } from "../diff-renderer.ts";
import { renderReplayOverlay } from "../round-replay.ts";
import type { ReplayData } from "../../rounds/replay.ts";

export interface ReplayOverlayHost {
  /** The reserved landmark the overlay is drawn into, emptied when it closes. */
  root: HTMLElement;
  renderer: DiffRenderer;
  /** After the overlay is gone, however it closed: skip, Done, Esc. */
  onClose(): void;
}

/** What the mount is asked to show; who may ask, and when, is `main.ts`'s call. */
export interface ReplayOpening {
  data: ReplayData;
  roundReply?: string;
}

export interface ReplayOverlayControl {
  open(replay: ReplayOpening): void;
}

/**
 * Clicks around `round-replay.ts`'s markup. Card moves are full redraws (cards
 * are static; nothing to preserve), and every exit goes through one `close` so
 * skip, Done and Esc land in the same place. Dialog focus: primary button on
 * open, previous holder on close.
 */
export function mountReplayOverlay(host: ReplayOverlayHost): ReplayOverlayControl {
  let open: ReplayOpening | undefined;
  let current = 0;
  let before: Element | null = null;

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };

  const close = (): void => {
    if (open === undefined) return;
    open = undefined;
    host.root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
    if (before instanceof HTMLElement) before.focus();
    before = null;
    host.onClose();
  };

  const show = (index: number): void => {
    if (open === undefined) return;
    current = Math.min(Math.max(index, 0), open.data.comments.length - 1);
    draw();
  };

  const draw = (): void => {
    if (open === undefined) return;
    host.root.innerHTML = renderReplayOverlay(
      { data: open.data, roundReply: open.roundReply, current },
      host.renderer,
    );
    const last = open.data.comments.length - 1;
    host.root.querySelector(".lsr-replay-prev")?.addEventListener("click", () => show(current - 1));
    host.root.querySelector(".lsr-replay-skip")?.addEventListener("click", close);
    for (const dot of host.root.querySelectorAll<HTMLElement>(".lsr-replay-dot")) {
      dot.addEventListener("click", () => show(Number(dot.dataset.index ?? 0)));
    }
    const next = host.root.querySelector<HTMLElement>(".lsr-replay-next");
    next?.addEventListener("click", () => (current >= last ? close() : show(current + 1)));
    next?.focus();
  };

  return {
    open(replay) {
      // Callers already guard empty, but an empty dialog trapping focus would
      // be the worse failure.
      if (replay.data.comments.length === 0) return;
      if (open === undefined) {
        document.addEventListener("keydown", onKey);
        before = document.activeElement;
      }
      open = replay;
      current = 0;
      draw();
    },
  };
}
