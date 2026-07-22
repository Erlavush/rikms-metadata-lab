import assert from "node:assert/strict";
import test from "node:test";
import { scoreField } from "./evaluation.js";

test("scores normalized exact fields and unordered lists", () => {
  assert.equal(scoreField("title", "  A Study—Of Water ", "a study of water"), 1);
  assert.equal(scoreField("keywords", ["Water", "Climate"], ["climate", "water"]), 1);
  assert.equal(scoreField("suggested_sdgs", [
    { number: 6, reason: "Water", confidence: 0.9 },
    { number: 13, reason: "Climate", confidence: 0.8 },
  ], [
    { number: 13, reason: "Different rationale", confidence: 0.5 },
    { number: 6, reason: "Different rationale", confidence: 0.5 },
  ]), 1);
});

test("uses token F1 for grounded summaries", () => {
  const score = scoreField("methodology", "survey of 100 students", "a survey of students");
  assert.ok(score > 0.5 && score < 1);
});
