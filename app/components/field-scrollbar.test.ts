import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const globalStyles = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

test("long metadata values use a hollow scrollbar with solid triangle arrows", () => {
  assert.match(globalStyles, /\.field-value\s*\{[^}]*scrollbar-color:\s*auto/);
  assert.match(globalStyles, /\.field-value::\-webkit-scrollbar-track\s*\{[^}]*border:\s*var\(--rule-medium\) solid var\(--color-ink\)[^}]*background:\s*var\(--color-transparent\)/);
  assert.match(globalStyles, /\.field-value::\-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--color-transparent\)[^}]*box-shadow:\s*inset 0 0 0 var\(--rule-medium\) var\(--color-ink\)/);
  assert.match(globalStyles, /\.field-value::\-webkit-scrollbar-button:single-button\s*\{[^}]*border:\s*0[^}]*border-radius:\s*0[^}]*background-color:\s*var\(--color-transparent\)/);
  assert.match(globalStyles, /\.field-value::\-webkit-scrollbar-button:single-button:vertical:decrement\s*\{[^}]*background-image:\s*url\("data:image\/svg\+xml,[^}]*M6 2 11 10H1z/);
  assert.match(globalStyles, /\.field-value::\-webkit-scrollbar-button:single-button:vertical:increment\s*\{[^}]*background-image:\s*url\("data:image\/svg\+xml,[^}]*M1 2h10L6 10z/);
});
