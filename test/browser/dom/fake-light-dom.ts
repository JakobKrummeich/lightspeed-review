/**
 * Boxes that know where they are on screen. The light moments measure the page
 * and lay elements over it, which neither the diff's fake (vertical layout
 * only) nor the panel's (no layout) models. No jsdom in this repo; see
 * `fake-dom.ts` for why.
 */
import type { TestContext } from "node:test";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

class FakeStyle {
  private readonly properties = new Map<string, string>();

  setProperty(name: string, value: string): void {
    this.properties.set(name, value);
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name) ?? "";
  }
}

export class FakeBox {
  readonly tagName: string;
  className: string;
  textContent = "";
  value = "";
  parentElement: FakeBox | null = null;
  readonly children: FakeBox[] = [];
  readonly style = new FakeStyle();
  /** Read to flush styles; a fake has none to flush. */
  readonly offsetWidth = 0;
  box: Box = { left: 0, top: 0, width: 0, height: 0 };
  private readonly attributes = new Map<string, string>();

  constructor(tag = "div", className = "", attributes: Record<string, string> = {}) {
    this.tagName = tag;
    this.className = className;
    for (const [name, value] of Object.entries(attributes)) this.attributes.set(name, value);
  }

  /** Sets where the box is and returns it, so a tree can be built in one expression. */
  at(box: Box): this {
    this.box = box;
    return this;
  }

  getBoundingClientRect(): Box & { right: number; bottom: number } {
    const { left, top, width, height } = this.box;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  get dataset(): Record<string, string> {
    const data: Record<string, string> = {};
    for (const [name, value] of this.attributes) {
      if (!name.startsWith("data-")) continue;
      data[name.slice(5).replace(/-(\w)/g, (_all, letter: string) => letter.toUpperCase())] = value;
    }
    return data;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  append(...children: FakeBox[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  remove(): void {
    const siblings = this.parentElement?.children;
    siblings?.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  /** Always deep, attributes and all, as `cloneNode(true)` is. */
  cloneNode(): FakeBox {
    const copy = new FakeBox(this.tagName, this.className, Object.fromEntries(this.attributes));
    copy.textContent = this.textContent;
    return copy.append(...this.children.map((child) => child.cloneNode()));
  }

  /** `#id`, `.class`, `[attribute]` or a tag: the selectors the light modules ask. */
  matches(selector: string): boolean {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith("[")) return this.attributes.has(selector.slice(1, -1));
    if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
    return this.tagName === selector;
  }

  closest(selector: string): FakeBox | null {
    if (this.matches(selector)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  querySelector(selector: string): FakeBox | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeBox[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

/** The compose box: the one element Warp Send tells apart by kind. */
export class FakeTextArea extends FakeBox {
  constructor(attributes: Record<string, string> = {}) {
    super("textarea", "", attributes);
  }
}

export class FakeLightDocument {
  readonly body = new FakeBox("body");

  createElement(tag: string): FakeBox {
    return new FakeBox(tag);
  }

  querySelector(selector: string): FakeBox | null {
    return this.body.querySelector(selector);
  }
}

/**
 * A document, an 800px-tall window and the textarea class, undone after the
 * test; `setTimeout` is mocked, so a test says when a moment is over.
 */
export function installLightDom(t: TestContext): FakeLightDocument {
  const globals = globalThis as Record<string, unknown>;
  const before = {
    document: globals.document,
    window: globals.window,
    textarea: globals.HTMLTextAreaElement,
  };
  const page = new FakeLightDocument();
  globals.document = page;
  globals.window = { innerHeight: 800 };
  globals.HTMLTextAreaElement = FakeTextArea;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    globals.document = before.document;
    globals.window = before.window;
    globals.HTMLTextAreaElement = before.textarea;
  });
  return page;
}

export function asElement(box: FakeBox): HTMLElement {
  return box as unknown as HTMLElement;
}
