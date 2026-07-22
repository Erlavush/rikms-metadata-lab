import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLabConfig } from "../config.js";
import { resolveCommand } from "../process.js";
import { writeSyntheticPdf } from "../test-pdf.js";
import { classifyDocumentLine, parseNativePdf } from "./native.js";

test("uses the same heading rules for native parsing and OCR", () => {
  assert.equal(classifyDocumentLine("METHODOLOGY", 2, 100, 792, 8), "heading");
  assert.equal(classifyDocumentLine("EXECUTIVE SUMMARY", 2, 100, 792, 9), "heading");
  assert.equal(classifyDocumentLine("3 Analytical properties of the transition matrix", 3, 100, 792, 9), "heading");
  assert.equal(classifyDocumentLine("T", 4, 100, 792, 10), "paragraph");
  assert.equal(classifyDocumentLine("K +", 4, 120, 792, 11), "paragraph");
  assert.equal(classifyDocumentLine("S :=", 4, 140, 792, 12), "paragraph");
  assert.equal(classifyDocumentLine("Let", 4, 160, 792, 13), "paragraph");
  assert.equal(classifyDocumentLine("Define the S-matrix as", 4, 180, 792, 14), "paragraph");
  assert.equal(classifyDocumentLine("This is ordinary prose without terminal punctuation", 2, 100, 792, 10), "paragraph");
});

test("builds page-aware canonical blocks from a real PDF", { skip: !resolveCommand("pdftotext") }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rikms-native-test-"));
  try {
    const filePath = path.join(directory, "proposal.pdf");
    writeSyntheticPdf(filePath, [[
      "A WATER QUALITY RESEARCH PROPOSAL",
      "BY",
      "Alex Rivera",
      "ABSTRACT",
      "This proposal evaluates community water quality using a repeatable survey and laboratory protocol.",
      "METHODOLOGY",
      "The team will sample one hundred households and analyze bacterial indicators.",
    ]]);
    const result = await parseNativePdf(filePath, loadLabConfig(directory));
    assert.equal(result.inventory.pages, 1);
    assert.ok(result.blocks.length >= 7);
    assert.ok(result.blocks.some((block) => block.text.includes("WATER QUALITY")));
    const abstractText = result.blocks.find((block) => block.text.startsWith("This proposal evaluates"));
    assert.equal(abstractText?.type, "paragraph");
    assert.deepEqual(abstractText?.sectionPath, ["ABSTRACT"]);
    assert.ok(result.pages[0].nativeCharacters > 100);
    assert.ok(result.blocks.every((block) => block.width > 0 && block.height > 0));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
