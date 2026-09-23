import { FakeNode } from "./fake-panel-dom.ts";
import type { FakeElement } from "./fake-dom.ts";

/** A `fake-panel-dom` node plus the fields a floating element needs. */
export class FakePopup extends FakeNode {
  className = "";
  readonly style: Record<string, string> = {};
  size = { width: 352, height: 300 };

  /**
   * Zero while hidden, as a real `display: none` element measures — a mount
   * that measured before showing would place the popup as if it had no height.
   */
  get offsetWidth(): number {
    return this.hidden ? 0 : this.size.width;
  }

  get offsetHeight(): number {
    return this.hidden ? 0 : this.size.height;
  }

  /** Only the popup itself: the fake selection never sits inside it. */
  contains(node: unknown): boolean {
    return node === this;
  }
}

export interface FakeScreen {
  innerWidth: number;
  innerHeight: number;
  scrollX: number;
  scrollY: number;
}

const DEFAULT_SCREEN: FakeScreen = {
  innerWidth: 1000,
  innerHeight: 800,
  scrollX: 0,
  scrollY: 0,
};

export interface FakePopupDom {
  popup: FakePopup;
  commentBox(): FakeNode | null;
  select(selection: Selection | undefined): Promise<void>;
  cleared: number;
}

/** Callers pass `t.after` so the harness cannot outlive its test. */
export function installPopupDom(
  after: (restore: () => void) => void,
  screen: Partial<FakeScreen> = {},
): FakePopupDom {
  const popup = new FakePopup("div");
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const handle: FakePopupDom = {
    popup,
    commentBox: () => popup.querySelector("#lsr-annotation-comment"),
    cleared: 0,
    async select(selection) {
      current = selection;
      for (const listener of listeners.get("mouseup") ?? []) listener({});
      // The mount reads the selection a tick later, once the click that
      // dismissed the last popup has finished.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
  let current: Selection | undefined;

  const document = {
    createElement: () => popup,
    body: { append: () => {} },
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    getSelection: () =>
      current === undefined
        ? null
        : {
            ...current,
            anchorNode: undefined,
            removeAllRanges: () => {
              handle.cleared += 1;
            },
          },
  };
  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    window: globals.window,
    HTMLElement: globals.HTMLElement,
  };
  globals.document = document;
  globals.window = { ...DEFAULT_SCREEN, ...screen };
  // The mount asks `instanceof HTMLElement` of a click's target, and every node
  // the fake popup builds is one of these.
  globals.HTMLElement = FakeNode;
  after(() => Object.assign(globals, before));
  return handle;
}

/** In client coordinates. */
export interface FakeSelectionRect {
  top: number;
  bottom: number;
  left: number;
}

const DEFAULT_RECT: FakeSelectionRect = { top: 24, bottom: 40, left: 12 };

export function placedSelection(
  selection: Selection,
  rect: Partial<FakeSelectionRect> = {},
): Selection {
  const range = selection.getRangeAt(0) as Range & { getBoundingClientRect?: unknown };
  // Only the three edges the placement reads; the rest of a `DOMRect` is not a
  // fact this fake has.
  range.getBoundingClientRect = () => ({ ...DEFAULT_RECT, ...rect }) as DOMRect;
  return selection;
}

export function asDiffRoot(fake: FakeElement): HTMLElement {
  return fake as unknown as HTMLElement;
}
