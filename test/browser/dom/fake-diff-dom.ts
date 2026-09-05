/**
 * Just enough DOM to mount the diff view, modelled as a tree because the diff's markup nests
 * (the panel's fake keeps a flat list). No jsdom in this repo; see `fake-dom.ts` for why.
 */

/** Tags that never close, so the parser must not push them on its stack. */
const VOID_TAGS = new Set(["input", "br", "hr", "img", "meta", "link", "col", "source"]);

const TAG = /<(\/)?([a-zA-Z][\w-]*)((?:[^>"]|"[^"]*")*?)(\/)?>/g;
const ATTRIBUTE = /([\w:-]+)(?:="([^"]*)")?/g;

export class FakeElement {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  parent: FakeElement | undefined;
  /** Crude layout: this element's own pixel worth. Tests set it on boxes they care about; everything else is zero. */
  ownHeight = 0;
  /** How much of a scroller shows at once; zero everywhere else, which makes its offset immovable. */
  clientHeight = 0;
  private offset = 0;
  /** Explicit box for the route overlay: the crude layout is vertical only, so 2-D map tests assign rects outright. */
  rect: { left: number; top: number; width: number; height: number } | undefined;
  /** What the fold writes a height into, and clears again when it settles. */
  readonly style: { height: string } = { height: "" };
  private readonly attributes = new Map<string, string>();
  private ownText = "";
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(tag = "div", attributes = "") {
    this.tagName = tag;
    for (const [, name, value] of attributes.matchAll(ATTRIBUTE)) {
      this.attributes.set(name!, value ?? "");
    }
  }

  get innerHTML(): string {
    return this.children.map((child) => child.outerHTML).join("");
  }

  set innerHTML(html: string) {
    this.children.length = 0;
    this.ownText = "";
    for (const child of parseNodes(html)) {
      child.parent = this;
      this.children.push(child);
    }
  }

  get outerHTML(): string {
    const attributes = [...this.attributes].map(([name, value]) => ` ${name}="${value}"`).join("");
    return `<${this.tagName}${attributes}>${this.ownText}${this.innerHTML}</${this.tagName}>`;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  /** Assigning text replaces everything inside, as it does in a browser. */
  set textContent(text: string) {
    this.children.length = 0;
    this.ownText = text;
  }

  get dataset(): Record<string, string> {
    const data: Record<string, string> = {};
    for (const [name, value] of this.attributes) {
      if (name.startsWith("data-")) data[camelCase(name.slice(5))] = value;
    }
    return data;
  }

  get classList(): {
    contains: (name: string) => boolean;
    add: (name: string) => void;
    remove: (name: string) => void;
  } {
    return {
      contains: (name) => this.classes().includes(name),
      add: (name) => {
        if (!this.classes().includes(name)) {
          this.attributes.set("class", [...this.classes(), name].join(" "));
        }
      },
      remove: (name) => {
        this.attributes.set(
          "class",
          this.classes()
            .filter((held) => held !== name)
            .join(" "),
        );
      },
    };
  }

  /** Own height plus visible children, unless a fold wrote a height. Hidden costs nothing — that is the height a collapse removes. */
  get layoutHeight(): number {
    if (this.hidden) return 0;
    if (this.style.height !== "") return Number.parseFloat(this.style.height);
    return this.children.reduce((total, child) => total + child.layoutHeight, this.ownHeight);
  }

  /**
   * Clamped on read as well as write: a collapse shrinks content under a once-legal offset,
   * which is exactly the reading the scroll correction is measured against.
   */
  get scrollTop(): number {
    return Math.min(this.offset, this.maxScrollTop());
  }

  set scrollTop(offset: number) {
    this.offset = Math.max(0, Math.min(offset, this.maxScrollTop()));
  }

  /** Nothing to scroll past when nothing says how much of this element shows. */
  private maxScrollTop(): number {
    if (this.clientHeight === 0) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.scrollHeight - this.clientHeight);
  }

  /** Everything inside this element, on the screen or not yet scrolled to. */
  get scrollHeight(): number {
    return this.children.reduce((total, child) => total + child.layoutHeight, this.ownHeight);
  }

  /** Where this element sits in the viewport: its place in the page, less what is scrolled past. */
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    if (this.rect) return this.rect;
    return {
      left: 0,
      top: this.documentTop() - this.scrolledPast(),
      width: 0,
      height: this.layoutHeight,
    };
  }

  private documentTop(): number {
    const parent = this.parent;
    if (!parent) return 0;
    const before = parent.children.slice(0, parent.children.indexOf(this));
    return before.reduce((top, sibling) => top + sibling.layoutHeight, parent.documentTop());
  }

  /** Scroll offsets of the ancestors only: an element does not scroll past itself. */
  private scrolledPast(): number {
    let offset = 0;
    for (let node = this.parent; node !== undefined; node = node.parent) offset += node.scrollTop;
    return offset;
  }

  /** The highlighter reads this to drop work on replaced markup: reachable from the mounted root, or nobody's view. */
  get isConnected(): boolean {
    if (this.parent !== undefined) return this.parent.isConnected;
    return this === mountedRoot;
  }

  /** Backed by the attribute, so markup rendered with `hidden` starts hidden. */
  get hidden(): boolean {
    return this.attributes.has("hidden");
  }

  set hidden(hidden: boolean) {
    if (hidden) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }

  /** Puts an element inside this one: what the parser does for markup, done by hand. */
  append(child: FakeElement): void {
    child.parent = this;
    this.children.push(child);
  }

  /** Detaches this element, as `Element.remove` does; already loose is a no-op. */
  remove(): void {
    const parent = this.parent;
    if (parent === undefined) return;
    const at = parent.children.indexOf(this);
    if (at !== -1) parent.children.splice(at, 1);
    this.parent = undefined;
  }

  /** The overlay pulls its freshly parsed svg back out of a scratch element. */
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  /** What a delegated listener on this element sees; no bubbling is modelled. */
  dispatch(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;
    return this.parent?.closest(selector) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }

  matches(selector: string): boolean {
    return selector.split(",").some((one) => this.matchesOne(one.trim()));
  }

  /** True once the page scrolled this element on screen: a fake cannot move. */
  scrolledInto = false;

  scrollIntoView(): void {
    this.scrolledInto = true;
  }

  private matchesOne(selector: string): boolean {
    // Loud: an unreadable combinator would look exactly like a missing element.
    if (/\s/.test(selector)) throw new Error(`fake DOM: unsupported selector "${selector}"`);
    return [
      ...selector.matchAll(/^([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g),
    ].every(([, tag, className, attribute, value]) => {
      if (tag !== undefined) return this.tagName === tag;
      if (className !== undefined) return this.classes().includes(className);
      const held = this.attributes.get(attribute!);
      return value === undefined ? held !== undefined : held === value;
    });
  }

  private classes(): string[] {
    return (this.attributes.get("class") ?? "").split(" ").filter(Boolean);
  }
}

/** The one element the mount treats as more than a box: a tick it can read. */
export class FakeInput extends FakeElement {
  checked: boolean;

  constructor(tag = "input", attributes = "") {
    super(tag, attributes);
    this.checked = this.getAttribute("checked") !== null;
  }
}

/**
 * Keeps a stack (the mount navigates by nesting). A stray close tag is dropped, not thrown:
 * this reads rendered markup, not arbitrary HTML.
 */
function parseNodes(html: string): FakeElement[] {
  const roots: FakeElement[] = [];
  const open: FakeElement[] = [];
  let cursor = 0;
  const addText = (text: string): void => {
    const parent = open.at(-1);
    if (parent && text.trim() !== "") parent.textContent = parent.textContent + text;
  };
  for (const match of html.matchAll(TAG)) {
    const [tag, closing, name, attributes, selfClosing] = match;
    addText(html.slice(cursor, match.index));
    cursor = match.index + tag.length;
    if (closing) {
      const at = open.findLastIndex((element) => element.tagName === name);
      if (at !== -1) open.length = at;
      continue;
    }
    const element =
      name === "input" ? new FakeInput(name, attributes) : new FakeElement(name, attributes);
    const parent = open.at(-1);
    if (parent) {
      element.parent = parent;
      parent.children.push(element);
    } else {
      roots.push(element);
    }
    if (!selfClosing && !VOID_TAGS.has(name!)) open.push(element);
  }
  return roots;
}

const camelCase = (name: string): string =>
  name
    .split("-")
    .map((part, index) => (index === 0 ? part : part.slice(0, 1).toUpperCase() + part.slice(1)))
    .join("");

/**
 * Globals the mount reaches outside its root. `CSS.escape` is the identity on purpose:
 * the fake compares attribute values literally, so escaping would only break the match.
 */
export function installFakeDom(root: FakeElement): void {
  mountedRoot = root;
  Object.assign(globalThis, {
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeInput,
    CSS: { escape: (value: string) => value },
    document: {
      getElementById: (id: string) => root.querySelector(`[id="${id}"]`),
      // The highlighter parses its own output back into nodes before merging with intra-line marks.
      createElement: (tag: string) => new FakeElement(tag),
    },
  });
}

/** The root the current test mounted, which is what `isConnected` is measured against. */
let mountedRoot: FakeElement | undefined;

/** Hands a fake to code typed against the real DOM. */
export function asElement(fake: FakeElement): HTMLElement {
  return fake as unknown as HTMLElement;
}
