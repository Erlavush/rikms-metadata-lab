import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentBlock, FieldResult, ValidationReport } from "./contracts.js";
import { abstainRejectedCandidate, acceptanceScore, deterministicDoi, deterministicSectionCandidate, deterministicTitle, hasHardValidationFailure, resolveEvidence, retrieveCandidateBlocks, validateField } from "./fields.js";
import { fieldDefinitions } from "./schema.js";

function block(id: string, page: number, text: string, sectionPath: string[]): DocumentBlock {
  return {
    id, page, type: sectionPath.at(-1) === text ? "heading" : "paragraph", text,
    normalizedText: text.toLowerCase(), x: 10, y: 20, width: 300, height: 20,
    readingOrder: Number(id.replace(/\D/g, "")) || 1, sectionPath,
    sourceEngine: "poppler-tsv", sourceConfidence: 0.95, sourceIds: [id],
  };
}

test("resolves only exact document evidence and rejects fabricated quotes", () => {
  const blocks = [block("b1", 2, "The study surveyed 100 students using stratified sampling.", ["Methodology"])];
  const exact = resolveEvidence([{ blockId: "b1", quote: "surveyed 100 students" }], blocks);
  const fabricated = resolveEvidence([{ blockId: "b1", quote: "surveyed 500 teachers" }], blocks);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].page, 2);
  assert.deepEqual(fabricated, []);
});

test("resolves exact evidence spanning adjacent PDF line blocks", () => {
  const blocks = [
    block("b1", 10, "The key result is the proof of unitarity of the scattering matrix in the subspace of open", ["Conclusion"]),
    block("b2", 10, "channels even when closed channels are present.", ["Conclusion"]),
  ];
  const evidence = resolveEvidence([{
    blockId: "b1",
    quote: "The key result is the proof of unitarity of the scattering matrix in the subspace of open channels even when closed channels are present.",
  }], blocks);
  assert.deepEqual(evidence.map((item) => item.blockId), ["b1", "b2"]);
  assert.ok(evidence.every((item) => item.exactMatch));
});

test("retrieves field-specific sections ahead of irrelevant references", () => {
  const methodology = fieldDefinitions.find((definition) => definition.key === "methodology")!;
  const blocks = [
    block("b1", 1, "Introduction", ["Introduction"]),
    block("b2", 1, "General context for the study.", ["Introduction"]),
    block("b3", 2, "Methodology", ["Methodology"]),
    block("b4", 2, "Participants were selected by stratified sampling.", ["Methodology"]),
    block("b5", 6, "References", ["References"]),
    block("b6", 6, "Sampling handbook and research design manual.", ["References"]),
  ];
  const selected = retrieveCandidateBlocks(methodology, blocks, 1);
  assert.ok(selected.some((candidate) => candidate.id === "b4"));
  assert.ok(selected.findIndex((candidate) => candidate.id === "b4") < selected.findIndex((candidate) => candidate.id === "b6") || !selected.some((candidate) => candidate.id === "b6"));
});

test("field validation rejects unsupported and out-of-taxonomy values", () => {
  const category = validateField("category", "Astrology", [], true);
  assert.equal(category.fieldRules, "failed");
  assert.equal(category.evidence, "failed");
});

test("does not fabricate DOI evidence from trivial numeric page blocks", () => {
  const candidate = deterministicDoi([
    block("b1", 1, "1", []),
    block("b2", 1, "2", []),
  ], {
    version: "0.9.0",
    tei: "",
    durationMs: 1,
    metadata: {
      title: "A New Paper",
      authors: [],
      abstract: "",
      keywords: [],
      doi: "10.1007/reference-only",
      sections: [],
    },
  });
  assert.equal(candidate?.evidence.length, 0);
  assert.equal(validateField("doi", candidate?.value ?? "", [], true).evidence, "failed");
});

test("rejects a syntactically valid DOI that is absent from its cited evidence", () => {
  const validation = validateField("doi", "10.1146/j.2051-798x.2023.00001.s", [{
    blockId: "b1", page: 1, quote: "arXiv:2307.00473v1 [math-ph] 2 Jul 2023",
    x: 0, y: 0, width: 1, height: 1, sourceEngine: "poppler-tsv",
    exactMatch: true, semanticSupport: "not_checked", supportScore: null,
  }], true);
  assert.equal(validation.fieldRules, "failed");
  assert.match(validation.issues.join(" "), /does not appear literally/i);
});

test("requires keywords to come from an explicit keyword span", () => {
  const evidence = (blockId: string, quote: string) => [{
    blockId, page: 1, quote, x: 0, y: 0, width: 1, height: 1,
    sourceEngine: "poppler-tsv", exactMatch: true as const,
    semanticSupport: "not_checked" as const, supportScore: null,
  }];
  const inferred = validateField(
    "keywords",
    ["multichannel scattering", "Jost solutions"],
    evidence("b1", "This paper investigates multichannel scattering using Jost solutions."),
    true,
  );
  const explicit = validateField(
    "keywords",
    ["multichannel scattering", "Jost solutions"],
    evidence("b2", "Keywords: multichannel scattering; Jost solutions"),
    true,
  );
  assert.equal(inferred.fieldRules, "failed");
  assert.equal(explicit.fieldRules, "passed");
});

test("rejects an SDG reason that names a different goal number", () => {
  const validation = validateField("suggested_sdgs", [{
    number: 1,
    reason: "This aligns with Goal 6: Clean Water and Sanitation.",
    confidence: 0.95,
  }], [], false);
  assert.equal(validation.fieldRules, "failed");
  assert.match(validation.issues.join(" "), /different goal number/i);
});

test("rejects model output that repeats internal evidence framing", () => {
  const validation = validateField(
    "theoretical_framework",
    "[BLOCK native-p2-b1 | PAGE 2 | PARAGRAPH | SECTION Introduction] This should not reach the final value.",
    [],
    false,
  );
  assert.equal(validation.fieldRules, "failed");
  assert.match(validation.issues.join(" "), /internal evidence framing/i);
});

test("rejects generated HTML documents and code payloads in grounded summaries", () => {
  const html = validateField(
    "results_and_discussion",
    "<!DOCTYPE html><html><body><h1>Invented result</h1><p>Unsupported tasks</p></body></html>",
    [],
    false,
  );
  const fencedCode = validateField(
    "results_and_discussion",
    "```html\n<div>Invented benchmark walkthrough</div>\n```",
    [],
    false,
  );
  const citationSpan = validateField(
    "results_and_discussion",
    '<span class="citation">[Lewis et al., 2020]</span>',
    [],
    false,
  );
  const reasoningTag = validateField(
    "theoretical_framework",
    "<thinking></thinking> The evaluation compared two language models, but no theory was stated.",
    [],
    false,
  );
  const preamble = validateField(
    "methodology",
    "Based on the provided text, here is a summary of the benchmark procedure and evaluation rules.",
    [],
    false,
  );
  const markdown = validateField(
    "results_and_discussion",
    "**Model A** achieved a higher success rate, while <u>neither model</u> completed the hardest task.",
    [],
    false,
  );

  assert.equal(html.fieldRules, "failed");
  assert.equal(fencedCode.fieldRules, "failed");
  assert.equal(citationSpan.fieldRules, "failed");
  assert.equal(reasoningTag.fieldRules, "failed");
  assert.equal(preamble.fieldRules, "failed");
  assert.match(html.issues.join(" "), /document markup/i);
  assert.match(citationSpan.issues.join(" "), /too short|document markup/i);
  assert.match(preamble.issues.join(" "), /model-facing preamble/i);
  assert.equal(markdown.fieldRules, "passed");
});

test("rejects emoji in machine-generated metadata without rejecting mathematical symbols", () => {
  const emoji = validateField(
    "methodology",
    "The study applies topological data analysis to persistence diagrams and monodromy. 📚",
    [],
    false,
  );
  const mathematics = validateField(
    "methodology",
    "The study analyzes persistence diagrams in R² using λ, ±, and ∞ as mathematical notation.",
    [],
    false,
  );
  assert.equal(emoji.fieldRules, "failed");
  assert.match(emoji.issues.join(" "), /emoji or decorative pictographs/i);
  assert.equal(mathematics.fieldRules, "passed");
});

test("requires recommendations to contain supported action or future-work language", () => {
  const findings = validateField(
    "recommendations",
    ["LLMs struggle with reconnaissance tasks.", "Exploitation proved challenging for GPT-4."],
    [],
    false,
  );
  const actions = validateField(
    "recommendations",
    ["Future research should repeat each benchmark trial.", "Evaluate retrieval methods on more difficult machines."],
    [],
    false,
  );

  assert.equal(findings.fieldRules, "failed");
  assert.match(findings.issues.join(" "), /rather than restating findings/i);
  assert.equal(actions.fieldRules, "passed");
});

test("caps rejected evidence scores and abstains from displaying the rejected value", () => {
  const validation: ValidationReport = {
    schema: "passed",
    fieldRules: "passed",
    evidence: "passed",
    crossSource: "not_checked",
    issues: ["Second-pass verifier did not find sufficient semantic support."],
  };
  const rawScore = acceptanceScore({
    validation,
    evidence: [],
    parserScore: 0.95,
    sourceAgreement: null,
    verbalizedConfidence: 0.95,
    semanticChecked: true,
    semanticSupported: false,
    semanticScore: 0.2,
  });
  const rejected: FieldResult = {
    field: "results_and_discussion",
    provider: "ollama",
    strategy: "grounded_summary",
    status: "needs_review",
    value: "<!DOCTYPE html><html><body>Invented tasks</body></html>",
    method: "grounded_summary-model",
    evidence: [{
      blockId: "b1", page: 4, quote: "Actual benchmark evidence.", x: 0, y: 0, width: 1, height: 1,
      sourceEngine: "docling", exactMatch: true, semanticSupport: "unsupported", supportScore: 0.2,
    }],
    rawAcceptanceScore: rawScore,
    acceptanceScore: 0.86,
    calibration: "uncalibrated",
    reviewPriority: "low",
    attempts: 2,
    validation,
    model: "local-model",
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 500,
    error: null,
  };

  const abstained = abstainRejectedCandidate("results_and_discussion", rejected);
  assert.equal(rawScore, 0.49);
  assert.equal(abstained.value, "");
  assert.equal(abstained.status, "needs_review");
  assert.equal(abstained.evidence.length, 0);
  assert.equal(abstained.acceptanceScore, 0.49);
  assert.equal(abstained.reviewPriority, "high");
  assert.match(abstained.validation.issues.join(" "), /no unsupported value was retained/i);
});

test("keeps the precise layout title when GROBID appends a byline marker", () => {
  const title = { ...block("b1", 1, "Community Water Quality Monitoring: A Research Proposal", []), type: "title" as const };
  const selected = deterministicTitle([title], {
    version: "0.9.0",
    tei: "",
    durationMs: 1,
    metadata: {
      title: "Community Water Quality Monitoring: A Research Proposal BY",
      authors: ["Alex Rivera"],
      abstract: "",
      keywords: [],
      doi: "",
      sections: [],
    },
  });
  assert.equal(selected?.value, title.text);
  assert.equal(selected?.method, "grobid-header+layout-agreement");
  assert.equal(selected?.sourceAgreement, true);
});

test("reconstructs a multiline scholarly title and treats the GROBID header as agreement", () => {
  const first = { ...block("b1", 1, "Multichannel scattering for the Schrödinger", []), type: "title" as const, readingOrder: 1 };
  const second = { ...block("b2", 1, "equation on a line with different thresholds at both infinities", []), type: "title" as const, readingOrder: 2 };
  const byline = { ...block("b3", 1, "P.O. Kazinski and P.S. Korolev", []), type: "title" as const, readingOrder: 3 };
  const fullTitle = `${first.text} ${second.text}`;
  const selected = deterministicTitle([first, second, byline], {
    version: "0.9.0",
    tei: "",
    durationMs: 1,
    metadata: { title: fullTitle, authors: ["P O Kazinski", "P S Korolev"], abstract: "", keywords: [], doi: "", sections: [] },
  });

  assert.equal(selected?.value, fullTitle);
  assert.equal(selected?.method, "grobid-header+layout-agreement");
  assert.equal(selected?.sourceAgreement, true);
  assert.deepEqual(selected?.evidence, [
    { blockId: "b1", quote: first.text },
    { blockId: "b2", quote: second.text },
  ]);
});

test("requires title evidence to cover the title rather than an unrelated arXiv banner", () => {
  const evidence = resolveEvidence(
    [{ blockId: "b1", quote: "arXiv:2307.00473v1 [math-ph] 2 Jul 2023" }],
    [block("b1", 1, "arXiv:2307.00473v1 [math-ph] 2 Jul 2023", [])],
  );
  const validation = validateField(
    "title",
    "Multichannel scattering for the Schrödinger equation on a line with different thresholds at both infinities",
    evidence,
    true,
  );
  assert.equal(validation.fieldRules, "failed");
  assert.match(validation.issues.join(" "), /does not cover the complete proposed title/i);
});

test("treats verifier disagreement as reviewable but invalid evidence as a hard failure", () => {
  const verifierDisagreement: ValidationReport = {
    schema: "passed",
    fieldRules: "passed",
    evidence: "passed",
    crossSource: "not_checked",
    issues: ["Second-pass verifier did not find sufficient semantic support."],
  };
  const invalidEvidence: ValidationReport = { ...verifierDisagreement, evidence: "failed" };
  assert.equal(hasHardValidationFailure(verifierDisagreement), false);
  assert.equal(hasHardValidationFailure(invalidEvidence), true);
});

test("extracts a short explicit section before asking a model to summarize it", () => {
  const blocks = [
    block("b1", 2, "Methodology", ["Methodology"]),
    block("b2", 2, "Researchers surveyed one hundred households and tested bacterial indicators.", ["Methodology"]),
  ];
  const selected = deterministicSectionCandidate("methodology", blocks);
  assert.equal(selected?.value, blocks[1].text);
  assert.equal(selected?.method, "explicit-section-extraction");
  assert.deepEqual(selected?.evidence, [{ blockId: "b2", quote: blocks[1].text }]);
});

test("does not mistake an unrelated summary subsection for an executive summary", () => {
  const unrelated = [
    block("b1", 6, "4.3.1 Ablation 1: Inject Summary", ["4.3.1 Ablation 1: Inject Summary"]),
    block("b2", 6, "The agent retained a rolling summary of prior actions during the benchmark.", ["4.3.1 Ablation 1: Inject Summary"]),
  ];
  const explicit = [
    block("b3", 1, "EXECUTIVE SUMMARY", ["EXECUTIVE SUMMARY"]),
    block("b4", 1, "The project evaluates a community monitoring workflow and reports its principal outcomes.", ["EXECUTIVE SUMMARY"]),
  ];

  assert.equal(deterministicSectionCandidate("executive_summary", unrelated), null);
  assert.equal(deterministicSectionCandidate("executive_summary", explicit)?.value, explicit[1].text);
});
