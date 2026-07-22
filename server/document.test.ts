import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentBlock, DocumentPage } from "./contracts.js";
import { mergeDocling, propagateSectionPaths } from "./document.js";

function block(id: string, readingOrder: number, text: string, type: DocumentBlock["type"] = "paragraph"): DocumentBlock {
  return {
    id,
    page: 1,
    type,
    text,
    normalizedText: text.toLowerCase(),
    x: 72,
    y: readingOrder * 20,
    width: 400,
    height: 14,
    readingOrder,
    sectionPath: [],
    sourceEngine: "poppler-tsv",
    sourceConfidence: 0.95,
    sourceIds: [id],
  };
}

test("does not replace useful native structure with one giant Docling block", () => {
  const nativeBlocks = [
    block("n1", 1, "Community Water Quality Monitoring", "title"),
    block("n2", 2, "Abstract", "heading"),
    block("n3", 3, "This proposal examines community water quality."),
    block("n4", 4, "Methodology", "heading"),
    block("n5", 5, "Researchers will survey households and test water."),
    block("n6", 6, "Executive Summary", "heading"),
  ];
  const text = nativeBlocks.map((item) => item.text).join("\n");
  const page: DocumentPage = {
    page: 1,
    width: 612,
    height: 792,
    nativeCharacters: text.replace(/\s/g, "").length,
    nativeWords: text.split(/\s+/).length,
    replacementRatio: 0,
    parseScore: 0.68,
    grade: "fair",
    reasons: [],
    ocrApplied: false,
    sourceEngine: "poppler-tsv",
    text,
  };
  const doclingBlock = {
    ...block("d1", 1, text.replace(/\n/g, " ")),
    sourceEngine: "docling",
    sourceIds: ["#/texts/0"],
  };
  const merged = mergeDocling([page], nativeBlocks, {
    blocks: [doclingBlock],
    version: "2.93.0",
    rawJson: {},
    durationMs: 1,
  }, [], "auto");
  assert.deepEqual(merged.adoptedPages, []);
  assert.deepEqual(merged.blocks.map((item) => item.id), nativeBlocks.map((item) => item.id));
  assert.equal(merged.pages[0].sourceEngine, "poppler-tsv");
});

test("repairs section numbers split from scholarly headings without changing source text", () => {
  const repaired = propagateSectionPaths([
    block("b1", 1, "2"),
    block("b2", 2, "Jost solutions and their analytical properties"),
    block("b3", 3, "Consider the matrix ordinary differential equation"),
  ]);
  assert.equal(repaired[1].type, "heading");
  assert.equal(repaired[1].text, "Jost solutions and their analytical properties");
  assert.deepEqual(repaired[1].sectionPath, ["2 Jost solutions and their analytical properties"]);
  assert.deepEqual(repaired[2].sectionPath, ["2 Jost solutions and their analytical properties"]);
});
