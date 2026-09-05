import { html } from "diff2html";
import { ColorSchemeType } from "diff2html/lib/types.js";
import type { DiffRenderer } from "./diff-renderer.ts";

export type DiffOutputFormat = "line-by-line" | "side-by-side";

export interface Diff2HtmlOptions {
  outputFormat?: DiffOutputFormat;
}

/**
 * diff2html escapes diff content itself, which is what makes it safe to inject
 * the result as HTML. The file list is off: groups already list the files.
 *
 * The colour scheme stays LIGHT on purpose: that is diff2html's plain, unnested
 * `--d2h-*` variable set, and `chrome.css` redefines those per scheme. Its own
 * dark and auto themes are driven by a media query alone, so they would ignore
 * a reviewer who picked light or dark by hand.
 */
export function createDiff2HtmlRenderer(options: Diff2HtmlOptions = {}): DiffRenderer {
  const outputFormat = options.outputFormat ?? "line-by-line";
  return {
    renderFile(diff: string): string {
      if (diff.trim() === "") return "";
      return html(diff, {
        drawFileList: false,
        outputFormat,
        colorScheme: ColorSchemeType.LIGHT,
      });
    },
  };
}
