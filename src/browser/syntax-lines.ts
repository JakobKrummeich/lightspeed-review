import type { HLJSApi } from "highlight.js";

/**
 * Highlights one side of a file — the old text or the new one — as a single
 * document and hands back one HTML string per line.
 *
 * Highlighting each diff line on its own is what a line-oriented view invites,
 * and it is wrong for every construct that spans lines: a block comment, a
 * template literal, and JSX, which highlight.js only recognises from the
 * expression it sits in. Feeding the side as one text and cutting the result up
 * afterwards is the only way those read correctly.
 *
 * Returns undefined when the cut does not line up with the input, so a caller
 * can fall back rather than paint one line's colours onto another.
 */
export function highlightSide(
  hljs: HLJSApi,
  language: string,
  lines: string[],
): string[] | undefined {
  if (lines.length === 0) return undefined;
  const { value } = hljs.highlight(lines.join("\n"), { language, ignoreIllegals: true });
  const split = splitHighlightedLines(value);
  return split.length === lines.length ? split : undefined;
}

/**
 * Cuts highlight.js output into lines, closing every open span at a line break
 * and reopening it on the next line, so each line stands on its own as HTML.
 *
 * Works on the markup rather than the DOM because highlight.js emits nothing
 * but `<span>` tags and escaped text, which makes this a small scan and keeps
 * it testable without a browser.
 */
export function splitHighlightedLines(html: string): string[] {
  const open: string[] = [];
  const lines: string[] = [];
  let current = "";
  for (const token of html.split(/(<span[^>]*>|<\/span>)/)) {
    if (token === "") continue;
    if (token.startsWith("<span")) {
      open.push(token);
      current += token;
    } else if (token === "</span>") {
      open.pop();
      current += token;
    } else {
      const parts = token.split("\n");
      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          lines.push(current + "</span>".repeat(open.length));
          current = open.join("");
        }
        current += part;
      }
    }
  }
  lines.push(current);
  return lines;
}
