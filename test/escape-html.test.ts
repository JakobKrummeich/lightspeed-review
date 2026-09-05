import assert from "node:assert/strict";
import test from "node:test";
import { escapeHtml } from "../src/escape-html.ts";

test("escapeHtml escapes every HTML-significant character", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("escapeHtml escapes the ampersand once, not twice", () => {
  assert.equal(escapeHtml("a & <b>"), "a &amp; &lt;b&gt;");
});

test("escapeHtml leaves plain text untouched", () => {
  assert.equal(escapeHtml("plain text 123"), "plain text 123");
});
