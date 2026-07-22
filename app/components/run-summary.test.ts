import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { runProgressLabel } from "../metadata.js";
import type { Extraction } from "../types.js";
import { RunSummary } from "./run-summary.js";

const globalStyles = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

function extraction(overrides: Partial<Extraction> = {}): Extraction {
  return {
    id: "run-one",
    documentId: "document-one",
    fileName: "research.pdf",
    fileSize: 1_024,
    sha256: "a".repeat(64),
    status: "failed",
    stage: "failed",
    progress: 44,
    extractionMethod: null,
    selectedProviders: ["ollama"],
    results: {},
    scores: {},
    reviews: [],
    events: [
      { stage: "selective_ocr", message: "Routing affected pages through OCR.", at: "2026-01-01T00:00:00.000Z" },
      { stage: "failed", message: "Rendered page could not be saved.", at: "2026-01-01T00:00:01.000Z" },
    ],
    pages: [],
    error: "Rendered page could not be saved.",
    cacheHit: false,
    cacheSourceRunId: null,
    pipelineVersion: "2.0.0",
    schemaVersion: "2.0.0",
    parserFingerprint: "fingerprint",
    documentType: null,
    language: null,
    pageCount: 28,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

test("run summary is a filename and paper-icon progress meter without dashboard copy", () => {
  const html = renderToStaticMarkup(createElement(RunSummary, { extraction: extraction({ status: "running", stage: "field_extraction", progress: 76 }) }));
  assert.match(html, /research\.pdf/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="76"/);
  assert.match(html, /paper-progress-percent[^>]*>76%/);
  assert.match(html, /paper-progress-elapsed[^>]*>Elapsed · 1s<\/small>/);
  assert.equal((html.match(/paper-progress-glyph/g) ?? []).length, 24);
  assert.equal((html.match(/data-filled="true"/g) ?? []).length, 18);
  assert.doesNotMatch(html, /RIKMS Metadata Lab · Processing|pipeline 2\.0\.0|<dt>|New run|Field Extraction/);
});

test("failed run progress stays accessible without restoring the generic failure panel", () => {
  const html = renderToStaticMarkup(createElement(RunSummary, { extraction: extraction() }));
  assert.match(html, /Processing stopped at 44 percent/);
  assert.match(html, /data-state="failed"/);
  assert.match(html, /Stopped after · 1s/);
  assert.doesNotMatch(html, /No metadata fields were finalized|run-failure-message/);
});

test("completed review keeps the machine extraction time frozen at awaiting review", () => {
  const html = renderToStaticMarkup(createElement(RunSummary, { extraction: extraction({
    status: "completed",
    stage: "completed",
    progress: 100,
    updatedAt: "2026-01-01T00:10:00.000Z",
    events: [
      { stage: "field_extraction", message: "Extracting fields.", at: "2026-01-01T00:00:30.000Z" },
      { stage: "awaiting_review", message: "Machine extraction finished.", at: "2026-01-01T00:02:00.000Z" },
      { stage: "completed", message: "Human review finished.", at: "2026-01-01T00:10:00.000Z" },
    ],
  }) }));
  assert.match(html, /Extraction time · 2m 00s/);
  assert.doesNotMatch(html, /10m 00s/);
});

test("paper progress icons are tightly packed inside a visible bordered track", () => {
  assert.match(globalStyles, /\.paper-progress-track\s*\{[\s\S]*?grid-template-columns:\s*repeat\(24, minmax\(0, 1fr\)\)[\s\S]*?gap:\s*0[\s\S]*?border:\s*var\(--rule-bold\) solid var\(--color-on-dark\)/);
  assert.match(globalStyles, /\.paper-progress-elapsed\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*font-size:\s*var\(--text-xs\)[^}]*font-variant-numeric:\s*tabular-nums/);
});

test("desktop quality controls form three full-height colored tabs outside the metadata card", () => {
  assert.match(tokens, /--rating-rail-width:\s*2\.0625rem/);
  assert.match(tokens, /--rating-rail-underlap:\s*var\(--space-md\)/);
  assert.match(globalStyles, /@media \(min-width: 60rem\)[\s\S]*?\.metadata-block\s*\{[^}]*padding-inline-end:\s*var\(--rating-rail-width\)[^}]*\}[\s\S]*?\.provider-result > \.rating-rail\s*\{[^}]*position:\s*absolute[^}]*inset-block:\s*0[^}]*inset-inline-end:\s*calc\(0rem - var\(--rating-rail-width\) - var\(--metadata-card-padding\)\)[^}]*width:\s*calc\(var\(--rating-rail-width\) \+ var\(--rating-rail-underlap\)\)[^}]*flex-direction:\s*column[^}]*gap:\s*0[^}]*overflow:\s*hidden[^}]*border-radius:\s*0 var\(--radius-card\) var\(--radius-card\) 0/);
  assert.match(globalStyles, /\.metadata-card:not\(\.is-comparison\) \.provider-result\s*\{[^}]*position:\s*static[^}]*\}[\s\S]*?\.metadata-card:not\(\.is-comparison\) \.provider-result > \.rating-rail\s*\{[^}]*inset-block:\s*0[^}]*inset-inline-end:\s*calc\(var\(--rating-rail-width\) \* -1\)/);
  assert.match(globalStyles, /\.metadata-card::after\s*\{[^}]*width:\s*var\(--rating-rail-underlap\)[^}]*background:\s*inherit/);
  assert.match(globalStyles, /\.metadata-card\.has-results\s*\{[^}]*border-start-end-radius:\s*0[^}]*border-end-end-radius:\s*0/);
  assert.match(globalStyles, /\.metadata-card::after\s*\{[^}]*border-radius:\s*0/);
  assert.match(globalStyles, /\.rating-correct\s*\{[^}]*background:\s*var\(--color-success\)[^}]*\}[\s\S]*?\.rating-partial\s*\{[^}]*background:\s*var\(--color-warning\)[^}]*\}[\s\S]*?\.rating-incorrect\s*\{[^}]*background:\s*var\(--color-error\)/);
  assert.match(globalStyles, /\.provider-result > \.rating-rail \.rating-dot\s*\{[^}]*flex:\s*1 1 0[^}]*border-radius:\s*0/);
  assert.match(globalStyles, /\.provider-result > \.rating-rail \.rating-dot \+ \.rating-dot\s*\{[^}]*margin-block-start:\s*calc\(var\(--space-lg\) \* -1\)/);
  assert.match(globalStyles, /\.provider-result > \.rating-rail \.rating-dot:nth-child\(2\)\s*\{[^}]*z-index:\s*2[^}]*border-start-end-radius:\s*var\(--radius-card\)/);
  assert.match(globalStyles, /\.provider-result > \.rating-rail \.rating-dot:nth-child\(3\)\s*\{[^}]*z-index:\s*3[^}]*border-start-end-radius:\s*var\(--radius-card\)[^}]*border-end-end-radius:\s*var\(--radius-card\)/);
});

test("review actions reflow before their labels can collide", () => {
  assert.match(globalStyles, /\.review-actions\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(6rem, 1fr\)\)/);
  assert.doesNotMatch(globalStyles, /\.review-actions\s*\{[^}]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
});

test("terminal progress wording never calls a failed run complete", () => {
  assert.equal(runProgressLabel(extraction()), "Stopped at 44% processed.");
  assert.equal(runProgressLabel(extraction({ progress: 100 })), "Stopped before completion.");
});
