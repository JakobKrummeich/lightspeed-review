/** Minimal stand-in for the DOM methods the gutter readers use; jsdom would cost more than the four lines they are. */
export class FakeText {
  readonly nodeType = 3;
  readonly childNodes: FakeNode[] = [];
  readonly textContent: string;

  constructor(text: string) {
    this.textContent = text;
  }

  contains(node: FakeNode): boolean {
    return node === this;
  }
}

export type FakeNode = FakeElement | FakeText;

export class FakeElement {
  readonly nodeType = 1;
  readonly tag: string;
  readonly classes: string[];
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  parent: FakeElement | undefined;
  private readonly text: FakeText | undefined;

  constructor(tag: string, classes: string[] = [], text = "") {
    this.tag = tag;
    this.classes = classes;
    this.text = text === "" ? undefined : new FakeText(text);
  }

  /** Text before elements, which is how the diff's own markup is built. */
  get childNodes(): FakeNode[] {
    return this.text === undefined ? [...this.children] : [this.text, ...this.children];
  }

  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parent = this;
      this.children.push(child);
    }
    return this;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  /** Supports the selector forms the source uses: `.class`, `tag`, comma lists. */
  matches(selector: string): boolean {
    return selector.split(",").some((one) => this.matchesOne(one.trim()));
  }

  private matchesOne(selector: string): boolean {
    return selector.startsWith(".")
      ? this.classes.includes(selector.slice(1))
      : this.tag === selector;
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

  contains(node: FakeNode): boolean {
    return node === this || this.childNodes.some((child) => child.contains(node));
  }
}

/** Hands a fake to code typed against the real DOM. */
export function asElement(fake: FakeElement): Element {
  return fake as unknown as Element;
}

/** The four boundary fields `selectionInLine` reads off a real `Range`. */
export function asRange(bounds: {
  startContainer: FakeNode;
  startOffset: number;
  endContainer: FakeNode;
  endOffset: number;
}): Range {
  return bounds as unknown as Range;
}

/** One end of a range: the node the boundary sits in, and how far into it. */
export interface FakeBoundary {
  node: FakeNode;
  offset: number;
}

/**
 * Enter/exit numbering per node from one walk. Two numbers, not one flat index: a range boundary
 * can sit *between* children, as browsers report a drag ending on a row or cell.
 */
function spansUnder(root: FakeNode): Map<FakeNode, { enter: number; exit: number }> {
  const spans = new Map<FakeNode, { enter: number; exit: number }>();
  let counter = 0;
  const walk = (node: FakeNode): void => {
    const enter = counter++;
    for (const child of node.childNodes) walk(child);
    spans.set(node, { enter, exit: counter++ });
  };
  walk(root);
  return spans;
}

/**
 * A range answering `intersectsNode` off the walk above. Over-inclusive at the edges like a
 * browser: a merely touched node counts, which the fragment builder must drop itself.
 */
export function fakeRange(root: FakeElement, start: FakeBoundary, end: FakeBoundary): Range {
  const spans = spansUnder(root);
  const spanOf = (node: FakeNode): { enter: number; exit: number } => {
    const span = spans.get(node);
    if (span === undefined) throw new Error(`node outside the range's root: ${node.textContent}`);
    return span;
  };
  // Text node: boundary is a char offset, sits at the node. Element: child index, sits where
  // that child begins — or at the element's end when it names none.
  const positionOf = ({ node, offset }: FakeBoundary): number => {
    if (node.nodeType === 3) return spanOf(node).enter;
    const child = node.childNodes[offset];
    return child === undefined ? spanOf(node).exit : spanOf(child).enter;
  };
  const from = positionOf(start);
  const to = positionOf(end);
  return {
    startContainer: start.node,
    startOffset: start.offset,
    endContainer: end.node,
    endOffset: end.offset,
    intersectsNode(node: FakeNode): boolean {
      const span = spanOf(node);
      return span.enter <= to && span.exit >= from;
    },
  } as unknown as Range;
}

/** A click is a selection too — collapsed, but with a range — so `collapsed` is answerable apart from having a range. */
export function asSelection(range: Range | undefined, collapsed = range === undefined): Selection {
  return {
    isCollapsed: collapsed,
    rangeCount: range === undefined ? 0 : 1,
    getRangeAt: () => range,
  } as unknown as Selection;
}

const element = (tag: string, classes: string[], text = ""): FakeElement =>
  new FakeElement(tag, classes, text);

/** One rendered diff line as diff2html builds it: prefix and code in sibling spans, the code cut into highlight spans. */
export function codeLine(
  prefix: string,
  pieces: string[],
  lineClass = "d2h-code-line",
): { line: FakeElement; content: FakeElement; texts: FakeText[] } {
  const spans = pieces.map((piece) => element("span", ["hljs-keyword"], piece));
  const content = element("span", ["d2h-code-line-ctn"]).append(...spans);
  const line = element("td", [lineClass], "\n      ").append(
    element("span", ["d2h-code-line-prefix"], prefix),
    content,
  );
  return {
    line,
    content,
    texts: spans.map((span) => span.childNodes[0] as FakeText),
  };
}

/** One line of a fake file block: its gutter numbers, its marker and its code. */
export interface FakeDiffLine {
  old?: number;
  new?: number;
  prefix: string;
  /** The code, in the pieces the highlighter cuts it into. */
  pieces: string[];
}

export type FakeCodeLine = ReturnType<typeof codeLine>;

/** A unified file block as the diff view renders one: `.lsr-file` wrapping numbered rows. */
export function diffFileBlock(options: { file: string; group?: string; lines: FakeDiffLine[] }): {
  block: FakeElement;
  lines: FakeCodeLine[];
} {
  const built = options.lines.map((line) => codeLine(line.prefix, line.pieces));
  const rows = options.lines.map((line, index) =>
    element("tr", []).append(
      element("td", ["d2h-code-linenumber"]).append(
        element("div", ["line-num1"], numberText(line.old)),
        element("div", ["line-num2"], numberText(line.new)),
      ),
      built[index]!.line,
    ),
  );
  const block = element("div", ["lsr-file"]).append(element("table", []).append(...rows));
  block.dataset.file = options.file;
  if (options.group !== undefined) block.dataset.group = options.group;
  return { block, lines: built };
}

/** The gutter number as diff2html prints it: empty for a line the version lacks. */
const numberText = (number: number | undefined): string =>
  number === undefined ? "" : String(number);

/**
 * Side-by-side render: two column tables under one `.lsr-file`. Which column holds a line decides
 * its version, so a fragment built here proves the anchor follows the column.
 */
export function sideBySideBlock(options: {
  file: string;
  group?: string;
  old: FakeDiffLine[];
  new: FakeDiffLine[];
}): { block: FakeElement; old: FakeCodeLine[]; new: FakeCodeLine[] } {
  const left = sideColumn(options.old);
  const right = sideColumn(options.new);
  const block = element("div", ["lsr-file"]).append(left.column, right.column);
  block.dataset.file = options.file;
  if (options.group !== undefined) block.dataset.group = options.group;
  return { block, old: left.built, new: right.built };
}

function sideColumn(lines: FakeDiffLine[]): { column: FakeElement; built: FakeCodeLine[] } {
  const built = lines.map((line) => codeLine(line.prefix, line.pieces, "d2h-code-side-line"));
  const rows = lines.map((line, index) =>
    element("tr", []).append(
      element("td", ["d2h-code-side-linenumber"], numberText(line.old ?? line.new)),
      built[index]!.line,
    ),
  );
  const column = element("div", ["d2h-file-side-diff"]).append(
    element("table", []).append(...rows),
  );
  return { column, built };
}

/** The container the popup scans, holding one or more file blocks. */
export function diffRoot(...blocks: FakeElement[]): FakeElement {
  return element("div", ["lsr-diff"]).append(...blocks);
}

/** A unified row: both numbers in one gutter cell, an empty one for "absent". */
export function unifiedRow(numbers: { old?: number; new?: number }): {
  row: FakeElement;
  line: FakeElement;
} {
  const line = element("td", ["d2h-code-line"], "+x");
  const row = element("tr", []).append(
    element("td", ["d2h-code-linenumber"]).append(
      element("div", ["line-num1"], numberText(numbers.old)),
      element("div", ["line-num2"], numberText(numbers.new)),
    ),
    line,
  );
  return { row, line };
}

/** A side-by-side file: one table per version, one number per row. */
export function sideBySideFile(numbers: { old?: number; new?: number }): {
  file: FakeElement;
  oldLine: FakeElement;
  newLine: FakeElement;
} {
  const column = (number: number | undefined): { side: FakeElement; line: FakeElement } => {
    const line = element("td", ["d2h-code-side-line"], "x");
    const side = element("div", ["d2h-file-side-diff"]).append(
      element("tr", []).append(
        element("td", ["d2h-code-side-linenumber"], numberText(number)),
        line,
      ),
    );
    return { side, line };
  };
  const left = column(numbers.old);
  const right = column(numbers.new);
  return {
    file: element("div", ["d2h-file-wrapper"]).append(left.side, right.side),
    oldLine: left.line,
    newLine: right.line,
  };
}
