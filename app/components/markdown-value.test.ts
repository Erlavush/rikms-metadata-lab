import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { MarkdownValue } from "./markdown-value.js";

const globalStyles = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

test("field values render sanitized GFM and controlled underline markup", () => {
  const html = renderToStaticMarkup(createElement(MarkdownValue, {
    value: "**Bold** *italic* <u>underlined</u> ~~removed~~ `code`\nnext line\n\n[unsafe](javascript:alert(1)) ![remote](https://example.com/pixel.png)<script>alert('x')</script>",
  }));

  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<u>underlined<\/u>/);
  assert.match(html, /<del>removed<\/del>/);
  assert.match(html, /<code>code<\/code><br\/>\s*next line/);
  assert.match(html, /\[Image omitted: remote\]/);
  assert.doesNotMatch(html, /<script|javascript:|pixel\.png/);
});

test("metadata card spacing is reduced by half at base and wide breakpoints", () => {
  assert.match(globalStyles, /\.metadata-card\s*\{[^}]*--metadata-card-padding:\s*var\(--space-xs\)/);
  assert.match(globalStyles, /@media \(min-width: 72rem\)[\s\S]*?\.metadata-card\s*\{[^}]*--metadata-card-padding:\s*var\(--space-sm\)/);
  assert.match(globalStyles, /@media \(min-width: 60rem\)[\s\S]*?\.provider-result\s*\{[^}]*padding-inline-end:\s*var\(--space-xs\)/);
});
