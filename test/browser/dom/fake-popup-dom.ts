import { FakeNode } from "./fake-panel-dom.ts";
import type { FakeElement } from "./fake-dom.ts";

/**
 * The globals `mountAnnotationPopup` reaches for, installed for one test. The
 * popup is a `fake-panel-dom` node plus the fields a floating element needs.
 */
export class FakePopup extends FakeNode {
  className = "";
  readonly style: Record<string, string> = {};
  /** What the popup would measure once the stylesheet has laid it out. */
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

/** The screen the popup is placed on, and how far the page under it is scrolled. */
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

/** What a test drives the popup with once the globals are in place. */
export interface FakePopupDom {
  popup: FakePopup;
  /** The comment box of the currently rendered popup, once a selection made one. */
  commentBox(): FakeNode | null;
  /** Plays a reviewer's drag: sets the selection, then fires `mouseup`. */
  select(selection: Selection | undefined): Promise<void>;
  /** Ranges the popup cleared after queueing, which is how it drops a selection. */
  cleared: number;
}

/**
 * Installs the globals and hands back the handles, restoring on teardown.
 * Callers pass `t.after` so the harness cannot outlive its test.
 */
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

/** Where on the screen a fake selection was dragged, in client coordinates. */
export interface FakeSelectionRect {
  top: number;
  bottom: number;
  left: number;
}

const DEFAULT_RECT: FakeSelectionRect = { top: 24, bottom: 40, left: 12 };

/** A selection that also answers the rectangle the popup is positioned by. */
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

/** Hands a fake diff to code typed against the real DOM. */
export function asDiffRoot(fake: FakeElement): HTMLElement {
  return fake as unknown as HTMLElement;
}
