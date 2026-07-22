import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { metadataFields } from "../metadata.js";
import type { FieldResult, ProviderResult } from "../types.js";
import { FieldCard } from "./field-card.js";
import { emptyResultMessage, ProviderField } from "./provider-field.js";

const field = metadataFields[0];
const fieldResult: FieldResult = {
  field: "title",
  provider: "ollama",
  strategy: "exact",
  status: "needs_review",
  value: "A Reviewable Research Title",
  method: "layout-title",
  evidence: [],
  rawAcceptanceScore: 0.62,
  acceptanceScore: 0.62,
  calibration: "uncalibrated",
  reviewPriority: "medium",
  attempts: 2,
  validation: { schema: "passed", fieldRules: "passed", evidence: "failed", crossSource: "not_checked", issues: ["Exact page evidence was not found."] },
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 10,
  error: null,
};
const result: ProviderResult = {
  provider: "ollama",
  model: "qwen3.5:4b",
  metadata: { title: fieldResult.value },
  fields: { title: fieldResult },
  inputTokens: 0,
  outputTokens: 0,
  durationMs: 10,
  estimatedCostUsd: 0,
};

test("quality rating, review decision, and attention details remain separate controls", () => {
  const html = renderToStaticMarkup(createElement(ProviderField, {
    field,
    result,
    fieldResult,
    comparison: false,
    rating: "partial",
    latestAction: "confirm",
    onRate: async () => undefined,
    onReview: async () => undefined,
    onEvidence: () => undefined,
  }));
  assert.match(html, /class="provider-result[^\"]*is-partial/);
  assert.match(html, /aria-label="Good quality"/);
  assert.match(html, /aria-label="Okay quality"[^>]*aria-pressed="true"/);
  assert.match(html, /aria-label="Bad quality"/);
  assert.match(html, /aria-label="Why this field needs attention"/);
  assert.match(html, /class="field-info-icon"/);
  assert.doesNotMatch(html, /<span aria-hidden="true">i<\/span>/);
  assert.match(html, /Exact page evidence was not found/);
  assert.doesNotMatch(html, />Why this needs attention</);
  assert.match(html, />Confirm<\/button>/);
});

test("a populated field card exposes a flush-edge class for its attached quality rail", () => {
  const html = renderToStaticMarkup(createElement(FieldCard, {
    field,
    busy: false,
    results: [["ollama", result]],
    scores: {},
    latestActions: {},
    onRate: async () => undefined,
    onReview: async () => undefined,
    onEvidence: () => undefined,
  }));

  assert.match(html, /class="metadata-card[^\"]*has-results/);
});

test("empty machine results explain their status instead of rendering a blank card", () => {
  assert.equal(emptyResultMessage("not_found"), "Not found in this document.");
  assert.equal(emptyResultMessage("not_applicable"), "Not applicable to this document type.");
  assert.equal(emptyResultMessage("needs_review"), "No evidence-backed candidate survived validation.");
});
