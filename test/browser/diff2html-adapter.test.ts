import { test } from "node:test";
import assert from "node:assert/strict";
import { createDiff2HtmlRenderer } from "../../src/browser/diff2html-adapter.ts";

const unifiedDiff = `diff --git a/src/api/users.ts b/src/api/users.ts
index 1111111..2222222 100644
--- a/src/api/users.ts
+++ b/src/api/users.ts
@@ -1,2 +1,2 @@
 const shared = 0;
-const old = 1;
+const fresh = 2;
`;

test("renders a unified diff as an html table containing both sides of the change", () => {
  const renderer = createDiff2HtmlRenderer();

  const html = renderer.renderFile(unifiedDiff);

  assert.match(html, /<table/);
  // diff2html marks intra-line edits up, so the removed/added words carry tags.
  assert.match(html, /d2h-del[\s\S]*<del>old<\/del>/);
  assert.match(html, /d2h-ins[\s\S]*<ins>fresh<\/ins>/);
});

test("escapes diff content so a changed line cannot inject markup", () => {
  const renderer = createDiff2HtmlRenderer();

  const html = renderer.renderFile(`${unifiedDiff}+<script>alert(1)</script>\n`);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("renders side by side when that output format is requested", () => {
  const renderer = createDiff2HtmlRenderer({ outputFormat: "side-by-side" });

  const html = renderer.renderFile(unifiedDiff);

  assert.match(html, /d2h-file-side-diff/);
});

test("leaves the colour scheme to the stylesheet's own tokens", () => {
  const html = createDiff2HtmlRenderer().renderFile(unifiedDiff);

  // diff2html's dark/auto rules answer only to the OS — they would fight a
  // hand-picked scheme. Its base `--d2h-*` variables are what chrome.css redefines.
  assert.doesNotMatch(html, /d2h-auto-color-scheme|d2h-dark-color-scheme/);
});

test("an empty diff renders nothing rather than throwing", () => {
  const renderer = createDiff2HtmlRenderer();

  assert.equal(renderer.renderFile("").trim(), "");
});
