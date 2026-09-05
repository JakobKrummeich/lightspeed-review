/**
 * Models node identity: assigning `innerHTML` throws away only that assignment's nodes, and the
 * panel redraws one section at a time (no jsdom in this repo, see `fake-dom.ts`).
 */
export class FakeNode {
  readonly tag: string;
  private readonly attributes: string;
  /** Set by the fake typist, like a reviewer's keystrokes. */
  value = "";
  /** Flat: the text up to the next tag, not everything underneath. */
  textContent = "";
  /** Scroll geometry a fake cannot lay out: tests state heights and watch what the panel does to scrollTop. */
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  /** Where that typist's caret sits, as a textarea reports it. */
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  private locked: boolean | undefined;
  private shown: boolean | undefined;
  private data: Record<string, string | undefined> | undefined;
  private html = "";
  private children: FakeNode[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(tag = "div", attributes = "") {
    this.tag = tag;
    this.attributes = attributes;
  }

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(html: string) {
    this.html = html;
    this.children = parseNodes(html);
  }

  /** The classes the markup gave this node, asked the way an element is asked. */
  get classList(): { contains(name: string): boolean } {
    const classes = this.attribute("class").split(" ");
    return { contains: (name: string) => classes.includes(name) };
  }

  /** The `id` the markup gave this node, as an element reports it. */
  get id(): string {
    return this.attribute("id");
  }

  /**
   * Built once and kept: the opening's peel moves `data-at` between sheets rather than redrawing,
   * so a dataset handing out fresh copies on every read would swallow the press.
   */
  get dataset(): Record<string, string | undefined> {
    this.data ??= readDataset(this.attributes);
    return this.data;
  }

  /** Markup's `disabled` or set since: the compose row is locked by patching in place, not redrawing. */
  get disabled(): boolean {
    return this.locked ?? / disabled/.test(this.attributes);
  }

  set disabled(locked: boolean) {
    this.locked = locked;
  }

  /** Same story as `disabled`: the round offer and replay reopen are shown/hidden in place. */
  get hidden(): boolean {
    return this.shown ?? / hidden/.test(this.attributes);
  }

  set hidden(away: boolean) {
    this.shown = away;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  /** True once the page put the caret here. */
  focused = false;

  focus(): void {
    this.focused = true;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  dispatch(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  querySelector(selector: string): FakeNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  /** The parser's only way in: markup nests, and this is what nests it. */
  adopt(child: FakeNode): void {
    this.children.push(child);
  }

  matches(selector: string): boolean {
    if (selector.startsWith("#")) return this.attribute("id") === selector.slice(1);
    if (selector.startsWith("."))
      return this.attribute("class").split(" ").includes(selector.slice(1));
    return this.tag === selector;
  }

  private attribute(name: string): string {
    return new RegExp(`${name}="([^"]*)"`).exec(this.attributes)?.[1] ?? "";
  }
}

/**
 * No self-closing case on purpose: `<p/>` opens a paragraph in real HTML and `href="docs/"` ends
 * in a slash — reading either as empty would flatten what follows. Void elements are a list.
 */
/** Every `data-` attribute of one tag, under the name an element reports it by. */
function readDataset(attributes: string): Record<string, string | undefined> {
  return Object.fromEntries(
    [...attributes.matchAll(/data-([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [
      (name ?? "").replace(/-(\w)/g, (_all, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

const TAG = /<(\/?)(\w+)([^>]*)>([^<]*)/g;
const VOID_TAGS = new Set(["br", "hr", "img", "input", "link", "meta"]);

function parseNodes(html: string): FakeNode[] {
  const roots: FakeNode[] = [];
  const open: FakeNode[] = [];
  const place = (node: FakeNode): void => {
    const parent = open.at(-1);
    if (parent) parent.adopt(node);
    else roots.push(node);
  };
  for (const [, closing, tag, attributes, text] of html.matchAll(TAG)) {
    if (closing) {
      open.pop();
      continue;
    }
    const node = new FakeNode(tag ?? "div", attributes ?? "");
    place(node);
    if (!VOID_TAGS.has(node.tag)) open.push(node);
    // Text belongs to whatever is open now: the placed node, or its parent for a void one.
    const holder = open.at(-1);
    if (holder && text) holder.textContent = text;
  }
  return roots;
}

/**
 * The panel asks `instanceof HTMLElement` and listens to `window` for the tab going away, so a
 * test needs both. Undone after the installing test, so nothing leaks.
 */
export function installFakeElements(after: (undo: () => void) => void): FakeWindow {
  const globals = globalThis as Record<string, unknown>;
  const before = { element: globals.HTMLElement, window: globals.window };
  const page = new FakeWindow();
  globals.HTMLElement = FakeNode;
  globals.window = page;
  after(() => {
    globals.HTMLElement = before.element;
    globals.window = before.window;
  });
  return page;
}

/** The page itself, as far as the panel uses it: something that can be left. */
export class FakeWindow {
  private readonly listeners = new Map<string, (() => void)[]>();

  addEventListener(type: string, handler: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  /** The reviewer closing the tab, or reloading it. */
  leave(): void {
    for (const handler of this.listeners.get("pagehide") ?? []) handler();
  }
}

/** Hands a fake to code typed against the real DOM. */
export function asPanelRoot(fake: FakeNode): HTMLElement {
  return fake as unknown as HTMLElement;
}
