import { escapeHtml } from "../escape-html.ts";
import { BRANCH_OPTION } from "./approved-form.ts";
import type { FileHighlight } from "./syntax-file.ts";

/**
 * The `Whole file` view: the file's entire new version, numbered and
 * highlighted like a diff. Pure, like `diff-view.ts`: markup asserted without
 * a DOM. Read-only in v1 — annotations stay anchored to the branch diff.
 */

/**
 * Names the press, not a literal: renaming the option must not leave this
 * sentence pointing at a button that is not there.
 */
const READ_ONLY = `Read-only view: annotations are filed on the branch diff — press ${BRANCH_OPTION.label} to leave one.`;

/** The whole file under the fetched forms' chrome: same note band, same diff surface. */
export function renderFullFile(contents: string, highlight: FileHighlight | undefined): string {
  const raw = contents.split("\n");
  // Aligned or dropped whole: a shifted highlight would paint one line's
  // colours onto another. Measured before the terminator pop below —
  // `highlightFile` counts that empty final entry too.
  const painted = highlight && highlight.html.length === raw.length ? highlight.html : undefined;
  // The final newline is a terminator, not one more empty line to number.
  if (raw.at(-1) === "") raw.pop();
  if (raw.length === 0) {
    return `<div class="lsr-approved-form">
      <p class="lsr-approved-missing">This file is empty.</p>
    </div>`;
  }
  return `<div class="lsr-approved-form">
      <p class="lsr-approved-note">${READ_ONLY}</p>
      <div class="lsr-approved-diff">${table(raw, painted)}</div>
    </div>`;
}

/**
 * diff2html's own unified markup, minus the diff: chrome.css and the bundled
 * d2h stylesheet were written against these classes, so the rows lay out and
 * colour exactly like a diff's context lines.
 */
function table(lines: string[], painted: string[] | undefined): string {
  const rows = lines.map((line, index) => row(index + 1, line, painted?.[index])).join("");
  return `<div class="d2h-wrapper"><div class="d2h-file-wrapper"><div class="d2h-file-diff"><div class="d2h-code-wrapper"><table class="d2h-diff-table"><tbody class="d2h-diff-tbody">${rows}</tbody></table></div></div></div></div>`;
}

/** `line-num1` present but empty: only the new side exists, and CSS hides num1 anyway. */
function row(number: number, line: string, painted: string | undefined): string {
  const ctn =
    painted === undefined
      ? `<span class="d2h-code-line-ctn">${escapeHtml(line)}</span>`
      : `<span class="d2h-code-line-ctn hljs">${painted}</span>`;
  return `<tr>
    <td class="d2h-code-linenumber d2h-cntx"><div class="line-num1"></div><div class="line-num2">${number}</div></td>
    <td class="d2h-cntx"><div class="d2h-code-line"><span class="d2h-code-line-prefix">&nbsp;</span>${ctn}</div></td>
</tr>`;
}
