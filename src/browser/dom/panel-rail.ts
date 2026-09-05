import { railBadge, railLabel, type RailState } from "../panel-collapse.ts";

export interface PanelRailOptions {
  /** The rail itself: a button that stays on screen while the panel is shut. */
  rail: HTMLElement;
  /** Carries `data-panel`, which is what the stylesheet lays out against. */
  page: HTMLElement;
  /** The panel opened or closed: the view breakpoint has to be asked again. */
  onToggle(): void;
}

export interface MountedRail {
  /** The reviewer's unsent queue changed, which the rail shows while shut. */
  setQueued(count: number): void;
  /** Opens a shut panel, for the one thing that must not be missed. */
  expand(): void;
}

/**
 * The rail is the panel's only way back: it is deliberately outside the panel,
 * so collapsing cannot take its own control off the screen with it. Nothing is
 * persisted — every session starts with the conversation open, because a
 * reviewer arriving at a fresh round is being asked to talk.
 */
export function mountPanelRail(options: PanelRailOptions): MountedRail {
  const badge = options.rail.querySelector<HTMLElement>(".lsr-rail-badge");
  let state: RailState = { collapsed: false, queued: 0 };

  const draw = (): void => {
    options.page.dataset.panel = state.collapsed ? "collapsed" : "open";
    options.rail.setAttribute("aria-expanded", String(!state.collapsed));
    options.rail.setAttribute("aria-label", railLabel(state));
    if (!badge) return;
    const text = railBadge(state);
    badge.textContent = text;
    badge.hidden = text === "";
  };

  const set = (next: RailState): void => {
    const toggled = next.collapsed !== state.collapsed;
    state = next;
    draw();
    if (toggled) options.onToggle();
  };

  options.rail.addEventListener("click", () => set({ ...state, collapsed: !state.collapsed }));
  draw();

  return {
    setQueued(count: number) {
      set({ ...state, queued: count });
    },
    expand() {
      set({ ...state, collapsed: false });
    },
  };
}
