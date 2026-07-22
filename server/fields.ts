import { ZodError } from "zod";
import type {
  DocumentBlock,
  DocumentPage,
  EvidenceSpan,
  FieldAttempt,
  FieldResult,
  FieldValue,
  ProviderKey,
  SdgSuggestion,
  ValidationReport,
} from "./contracts.js";
import type { LabConfig } from "./config.js";
import { extractFieldWithModel, verifySemanticSupport } from "./extraction.js";
import { fieldDefinitions, parseFieldValue, type FieldDefinition, type MetadataField } from "./schema.js";
import { researchCategories } from "./taxonomy.js";
import type { GrobidParseResult } from "./parsers/grobid.js";

export type DeterministicCandidate = {
  value: FieldValue;
  method: string;
  evidence: Array<{ blockId: string; quote: string }>;
  sourceAgreement: boolean | null;
};

type ProcessFieldsInput = {
  providers: ProviderKey[];
  documentType: string;
  pages: DocumentPage[];
  blocks: DocumentBlock[];
  grobid: GrobidParseResult | null;
  config: LabConfig;
  onResult: (result: FieldResult) => void;
  onAttempt?: (attempt: FieldAttempt) => void;
  calibrate?: (provider: ProviderKey, field: string, rawScore: number) => { score: number; calibrated: boolean };
  onProgress?: (completed: number, total: number, field: string, provider: ProviderKey) => void;
};

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[^\p{L}\p{N}.:/_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isEmptyValue(value: FieldValue): boolean {
  return value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

const groundedSummaryFields: MetadataField[] = [
  "methodology",
  "review_of_related_literature",
  "theoretical_framework",
  "results_and_discussion",
  "executive_summary",
];

function containsDocumentMarkup(value: string): boolean {
  if (/<!doctype\s+html|<!--[\s\S]*?-->|```(?:html|xml|javascript|typescript|tsx|jsx|bash|sh)?\s*[\s\S]*?```/i.test(value)) return true;
  return (value.match(/<\/?[A-Za-z][^>]*>/g) ?? []).some((tag) => !/^<\/?u>$/i.test(tag));
}

function groundedPlainText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/[`*_#>~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsModelPreamble(value: string): boolean {
  return /^(?:based on (?:the )?provided (?:text|evidence|blocks?|document)|the provided (?:text|evidence|blocks?)|here (?:is|are) (?:a|the) (?:summary|overview|analysis))/i.test(groundedPlainText(value));
}

function isRecommendation(value: string): boolean {
  const text = groundedPlainText(value);
  return /\b(?:recommend(?:s|ed|ation)?|should|must|ought to|future (?:work|research|studies)|further (?:work|research|study)|need(?:s)? to|could be improved|it is advisable)\b/i.test(text)
    || /^(?:increase|improve|develop|adopt|implement|conduct|evaluate|investigate|explore|establish|provide|strengthen|expand|reduce|ensure|prioritize|consider)\b/i.test(text);
}

function emptyValue(field: MetadataField): FieldValue {
  if (["authors", "keywords", "recommendations", "suggested_sdgs", "evidence_pages"].includes(field)) return [];
  if (field === "overall_confidence") return 0;
  return "";
}

function evidenceForText(text: string, blocks: DocumentBlock[], maximum = 4): Array<{ blockId: string; quote: string }> {
  const target = normalize(text);
  if (!target) return [];
  const exact = blocks.filter((block) => {
    const blockText = normalize(block.text);
    return blockText.includes(target) || (blockText.length >= 12 && target.includes(blockText));
  });
  if (exact.length) return exact.slice(0, maximum).map((block) => ({ blockId: block.id, quote: block.text }));
  const targetTerms = new Set(target.split(" ").filter((term) => term.length > 3));
  return blocks
    .map((block) => {
      const terms = new Set(normalize(block.text).split(" "));
      const overlap = [...targetTerms].filter((term) => terms.has(term)).length / Math.max(1, targetTerms.size);
      return { block, overlap };
    })
    .filter((item) => item.overlap >= 0.45)
    .sort((left, right) => right.overlap - left.overlap)
    .slice(0, maximum)
    .map(({ block }) => ({ blockId: block.id, quote: block.text }));
}

function sectionBlocks(blocks: DocumentBlock[], aliases: string[]): DocumentBlock[] {
  const normalizedAliases = aliases.map(normalize);
  return blocks.filter((block) => {
    const section = normalize(block.sectionPath.join(" "));
    const text = normalize(block.text);
    return normalizedAliases.some((alias) => section.includes(alias) || (block.type === "heading" && text.includes(alias)));
  });
}

function tokenSimilarity(left: string, right: string): number {
  const leftTerms = normalize(left).split(" ").filter(Boolean);
  const rightTerms = normalize(right).split(" ").filter(Boolean);
  if (!leftTerms.length || !rightTerms.length) return 0;
  const leftCounts = new Map<string, number>();
  const rightCounts = new Map<string, number>();
  leftTerms.forEach((term) => leftCounts.set(term, (leftCounts.get(term) ?? 0) + 1));
  rightTerms.forEach((term) => rightCounts.set(term, (rightCounts.get(term) ?? 0) + 1));
  const overlap = [...leftCounts.entries()].reduce((sum, [term, count]) => sum + Math.min(count, rightCounts.get(term) ?? 0), 0);
  const precision = overlap / leftTerms.length;
  const recall = overlap / rightTerms.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function groupedLayoutTitle(titleBlocks: DocumentBlock[]): DocumentBlock[] {
  const ordered = [...titleBlocks].sort((left, right) => left.readingOrder - right.readingOrder);
  if (!ordered.length) return [];
  const group = [ordered[0]];
  for (const candidate of ordered.slice(1)) {
    const previous = group.at(-1)!;
    const heightRatio = Math.min(previous.height, candidate.height) / Math.max(1, Math.max(previous.height, candidate.height));
    const verticalGap = candidate.y - (previous.y + previous.height);
    if (heightRatio < 0.85 || verticalGap < -2 || verticalGap > Math.max(previous.height, candidate.height) * 1.25) break;
    group.push(candidate);
  }
  return group;
}

function bestTitleEvidence(titleBlocks: DocumentBlock[], target: string): { blocks: DocumentBlock[]; similarity: number } {
  const ordered = [...titleBlocks].sort((left, right) => left.readingOrder - right.readingOrder);
  let best = { blocks: [] as DocumentBlock[], similarity: 0 };
  for (let start = 0; start < ordered.length; start += 1) {
    for (let end = start; end < ordered.length; end += 1) {
      const candidate = ordered.slice(start, end + 1);
      const similarity = tokenSimilarity(candidate.map((block) => block.text).join(" "), target);
      if (similarity > best.similarity) best = { blocks: candidate, similarity };
    }
  }
  return best;
}

export function deterministicTitle(blocks: DocumentBlock[], grobid: GrobidParseResult | null): DeterministicCandidate | null {
  const firstPage = blocks.filter((block) => block.page === 1 && block.type !== "header");
  const titleBlocks = firstPage
    .filter((block) => block.type === "title" && block.text.length >= 12)
    .filter((block) => !/^(university|college|department|republic of|school of)\b/i.test(block.text))
    .sort((left, right) => left.readingOrder - right.readingOrder);
  const cleanedGrobidTitle = (grobid?.metadata.title ?? "").replace(/\s+(?:prepared|submitted)?\s*by$/i, "").trim();
  if (cleanedGrobidTitle && titleBlocks.length) {
    const matched = bestTitleEvidence(titleBlocks, cleanedGrobidTitle);
    if (matched.similarity >= 0.82) {
      return {
        value: cleanedGrobidTitle,
        method: "grobid-header+layout-agreement",
        evidence: matched.blocks.map((block) => ({ blockId: block.id, quote: block.text })),
        sourceAgreement: true,
      };
    }
  }
  const selected = groupedLayoutTitle(titleBlocks);
  if (selected.length) {
    const layoutTitle = selected.map((block) => block.text).join(" ").trim();
    const similarity = cleanedGrobidTitle ? tokenSimilarity(layoutTitle, cleanedGrobidTitle) : null;
    const agreement = similarity === null ? null : similarity >= 0.82 ? true : similarity < 0.35 ? false : null;
    return {
      value: layoutTitle,
      method: agreement ? "layout-title+grobid-agreement" : "layout-title",
      evidence: selected.map((block) => ({ blockId: block.id, quote: block.text })),
      sourceAgreement: agreement,
    };
  }
  if (cleanedGrobidTitle) {
    return {
      value: cleanedGrobidTitle,
      method: "grobid-header",
      evidence: evidenceForText(cleanedGrobidTitle, firstPage, 4),
      sourceAgreement: null,
    };
  }
  return null;
}

function deterministicAuthors(blocks: DocumentBlock[], grobid: GrobidParseResult | null): DeterministicCandidate | null {
  const firstPage = blocks.filter((block) => block.page === 1);
  if (grobid?.metadata.authors.length) {
    const evidence = grobid.metadata.authors.flatMap((author) => evidenceForText(author, firstPage, 1));
    return { value: grobid.metadata.authors, method: "grobid-authors", evidence, sourceAgreement: evidence.length > 0 };
  }
  const byIndex = firstPage.findIndex((block) => /^(?:prepared|submitted)?\s*by\s*:?$/i.test(block.text.trim()));
  if (byIndex >= 0) {
    const authorBlocks = firstPage.slice(byIndex + 1, byIndex + 5).filter((block) => block.text.length < 160 && !/^(adviser|advisor|july|january|february|march|april|may|june|august|september|october|november|december)\b/i.test(block.text));
    const authors = authorBlocks.flatMap((block) => block.text.split(/\s*(?:,|\band\b)\s*/i)).map((item) => item.trim()).filter((item) => item.split(/\s+/).length >= 2);
    if (authors.length) return { value: authors, method: "byline-layout", evidence: authorBlocks.map((block) => ({ blockId: block.id, quote: block.text })), sourceAgreement: null };
  }
  return null;
}

function deterministicAbstract(blocks: DocumentBlock[], grobid: GrobidParseResult | null): DeterministicCandidate | null {
  const candidates = sectionBlocks(blocks, ["abstract"]);
  const content = candidates.filter((block) => block.type !== "heading").map((block) => block.text).join(" ").trim();
  const value = grobid?.metadata.abstract || content;
  if (!value) return null;
  const evidenceBlocks = candidates.filter((block) => block.type !== "heading").slice(0, 8);
  const evidence = evidenceBlocks.length
    ? evidenceBlocks.map((block) => ({ blockId: block.id, quote: block.text }))
    : evidenceForText(value.slice(0, 500), blocks, 6);
  return { value, method: grobid?.metadata.abstract ? "grobid-abstract" : "section-extraction", evidence, sourceAgreement: content ? normalize(value).includes(normalize(content).slice(0, 100)) : null };
}

function deterministicKeywords(blocks: DocumentBlock[], grobid: GrobidParseResult | null): DeterministicCandidate | null {
  if (grobid?.metadata.keywords.length) {
    const text = grobid.metadata.keywords.join(", ");
    return { value: grobid.metadata.keywords, method: "grobid-keywords", evidence: evidenceForText(text, blocks.filter((block) => block.page <= 3), 3), sourceAgreement: null };
  }
  for (const block of blocks.filter((candidate) => candidate.page <= 4)) {
    const match = block.text.match(/^(?:key\s*words?|index terms)\s*[:—-]\s*(.+)$/i);
    if (!match) continue;
    const keywords = match[1].split(/[;,•]/).map((item) => item.trim()).filter(Boolean);
    if (keywords.length) return { value: keywords, method: "keyword-line", evidence: [{ blockId: block.id, quote: block.text }], sourceAgreement: null };
  }
  return null;
}

function normalizeDoi(value: string): string {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi\s*:\s*/i, "").replace(/[),.;]+$/, "").toLowerCase();
}

export function deterministicDoi(blocks: DocumentBlock[], grobid: GrobidParseResult | null): DeterministicCandidate | null {
  const expressions = /\b10\.\d{4,9}\/[\w.()/:+-]+/i;
  const sources = [grobid?.metadata.doi ?? "", ...blocks.filter((block) => block.page <= 4).map((block) => block.text)];
  for (const source of sources) {
    const match = source.match(expressions);
    if (!match) continue;
    const value = normalizeDoi(match[0]);
    return { value, method: source === grobid?.metadata.doi ? "grobid-doi" : "doi-regex", evidence: evidenceForText(match[0], blocks, 2), sourceAgreement: grobid?.metadata.doi ? normalizeDoi(grobid.metadata.doi) === value : null };
  }
  return null;
}

export function deterministicSectionCandidate(field: MetadataField, blocks: DocumentBlock[]): DeterministicCandidate | null {
  if (!["methodology", "review_of_related_literature", "theoretical_framework", "results_and_discussion", "executive_summary"].includes(field)) return null;
  const definition = fieldDefinitions.find((item) => item.key === field);
  if (!definition) return null;
  const explicitAliases: Partial<Record<MetadataField, string[]>> = {
    methodology: ["methodology", "methods", "research design", "materials and methods"],
    review_of_related_literature: ["review of related literature", "related literature", "literature review", "related studies"],
    theoretical_framework: ["theoretical framework", "conceptual framework", "theoretical foundation", "framework of the study"],
    results_and_discussion: ["results and discussion", "results", "findings", "discussion", "analysis and interpretation"],
    executive_summary: ["executive summary"],
  };
  const aliases = (explicitAliases[field] ?? [definition.label]).map(normalize);
  const canonicalSection = (value: string) => normalize(value)
    .replace(/^(?:(?:chapter|section)\s+)?(?:\d+(?:\.\d+)*|[ivxlcdm]+)[. :_-]+/i, "")
    .replace(/^[. :_-]+|[. :_-]+$/g, "")
    .trim();
  const contentBlocks = blocks
    .filter((block) => aliases.includes(canonicalSection(block.sectionPath.at(-1) ?? "")))
    .filter((block) => block.type !== "heading" && !["header", "footer"].includes(block.type));
  const value = contentBlocks.map((block) => block.text).join(" ").trim();
  // Explicit short sections are already extractive metadata. Longer sections
  // still go through the bounded synthesis model and its retry path.
  if (value.length < 30 || value.length > 2_500 || contentBlocks.length > 8) return null;
  return {
    value,
    method: "explicit-section-extraction",
    evidence: contentBlocks.map((block) => ({ blockId: block.id, quote: block.text })),
    sourceAgreement: null,
  };
}

function deterministicCandidate(field: MetadataField, blocks: DocumentBlock[], grobid: GrobidParseResult | null): DeterministicCandidate | null {
  if (field === "title") return deterministicTitle(blocks, grobid);
  if (field === "authors") return deterministicAuthors(blocks, grobid);
  if (field === "abstract") return deterministicAbstract(blocks, grobid);
  if (field === "keywords") return deterministicKeywords(blocks, grobid);
  if (field === "doi") return deterministicDoi(blocks, grobid);
  const section = deterministicSectionCandidate(field, blocks);
  if (section) return section;
  return null;
}

export function retrieveCandidateBlocks(definition: FieldDefinition, blocks: DocumentBlock[], attempt: number): DocumentBlock[] {
  const usable = blocks.filter((block) => !["header", "footer"].includes(block.type));
  if (["title", "authors", "abstract", "keywords", "doi"].includes(definition.key)) {
    return usable.filter((block) => block.page <= (attempt > 1 ? 5 : 3)).slice(0, attempt > 1 ? 80 : 45);
  }
  const maximumPage = Math.max(1, ...usable.map((block) => block.page));
  const aliases = [...definition.aliases, definition.label].map(normalize);
  const terms = definition.searchTerms.map(normalize);
  const scored = usable.map((block, index) => {
    const section = normalize(block.sectionPath.join(" "));
    const text = normalize(block.text);
    let score = 0;
    aliases.forEach((alias) => {
      if (section.includes(alias)) score += 14;
      if (block.type === "heading" && text.includes(alias)) score += 12;
    });
    terms.forEach((term) => {
      if (section.includes(term)) score += 5;
      if (text.includes(term)) score += 2;
    });
    if (["paragraph", "caption", "table"].includes(block.type) && block.text.length >= 80) score += 2;
    if (block.text.length < 20 && block.type !== "heading") score -= 4;
    if (definition.key === "executive_summary" && ["abstract", "methodology", "results_and_discussion", "recommendations"].some((key) => section.includes(normalize(key)))) score += 5;
    if (definition.key === "recommendations" && block.page >= maximumPage * 0.7) score += 4;
    if (["category", "suggested_sdgs"].includes(definition.key) && (block.page <= 3 || block.page >= maximumPage * 0.7)) score += 3;
    if (/^(references|bibliography)$/i.test(block.sectionPath.at(-1) ?? "") && definition.key !== "review_of_related_literature") score -= 20;
    return { block, index, score };
  });
  const seeds = scored.filter((item) => item.score > 0).sort((left, right) => right.score - left.score).slice(0, attempt > 1 ? 40 : 22);
  const indices = new Set<number>();
  seeds.forEach((seed) => {
    const radius = attempt > 1 ? 3 : 1;
    for (let index = Math.max(0, seed.index - radius); index <= Math.min(usable.length - 1, seed.index + radius); index += 1) indices.add(index);
  });
  if (!indices.size) {
    const fallback = definition.key === "recommendations" ? usable.slice(-40) : usable.slice(0, attempt > 1 ? 80 : 45);
    return fallback;
  }
  return [...indices].sort((left, right) => left - right).map((index) => usable[index]).slice(0, attempt > 1 ? 90 : 55);
}

export function resolveEvidence(
  requested: Array<{ blockId: string; quote: string }>,
  allBlocks: DocumentBlock[],
): EvidenceSpan[] {
  const evidenceText = (value: string) => normalize(value).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const ordered = [...allBlocks].sort((left, right) => left.page - right.page || left.readingOrder - right.readingOrder);
  const byId = new Map(allBlocks.map((block) => [block.id, block]));
  const resolved: EvidenceSpan[] = [];
  const append = (block: DocumentBlock, quote: string) => {
    resolved.push({
      blockId: block.id,
      page: block.page,
      quote,
      x: block.x,
      y: block.y,
      width: block.width,
      height: block.height,
      sourceEngine: block.sourceEngine,
      exactMatch: true,
      semanticSupport: "not_checked",
      supportScore: null,
    });
  };
  for (const reference of requested) {
    const normalizedQuote = evidenceText(reference.quote);
    let block = byId.get(reference.blockId);
    if (!block || !evidenceText(block.text).includes(normalizedQuote)) {
      block = allBlocks.find((candidate) => evidenceText(candidate.text).includes(normalizedQuote));
    }
    if (block && normalizedQuote) {
      append(block, reference.quote.trim());
      continue;
    }
    if (normalizedQuote.length < 20) continue;
    const requestedIndex = ordered.findIndex((candidate) => candidate.id === reference.blockId);
    let matched: DocumentBlock[] = [];
    for (let size = 2; size <= 8 && !matched.length; size += 1) {
      const starts = Array.from({ length: Math.max(0, ordered.length - size + 1) }, (_, index) => index)
        .sort((left, right) => {
          const leftContains = requestedIndex >= left && requestedIndex < left + size ? 1 : 0;
          const rightContains = requestedIndex >= right && requestedIndex < right + size ? 1 : 0;
          return rightContains - leftContains;
        });
      for (const start of starts) {
        const window = ordered.slice(start, start + size);
        if (window.some((candidate) => candidate.page !== window[0].page)) continue;
        if (evidenceText(window.map((candidate) => candidate.text).join(" ")).includes(normalizedQuote)) {
          matched = window;
          break;
        }
      }
    }
    matched.forEach((candidate) => append(candidate, candidate.text));
  }
  return [...new Map(resolved.map((item) => [`${item.blockId}:${normalize(item.quote)}`, item])).values()];
}

export function validateField(field: MetadataField, value: FieldValue, evidence: EvidenceSpan[], requiresEvidence: boolean): ValidationReport {
  const issues: string[] = [];
  let schema: ValidationReport["schema"] = "passed";
  let fieldRules: ValidationReport["fieldRules"] = "passed";
  try {
    parseFieldValue(field, value);
  } catch (error) {
    schema = "failed";
    issues.push(error instanceof ZodError ? error.issues.map((issue) => issue.message).join("; ") : "Invalid field value.");
  }
  if (field === "doi" && typeof value === "string" && value && !/^10\.\d{4,9}\/[\w.()/:+-]+$/i.test(value)) {
    fieldRules = "failed";
    issues.push("DOI does not match the DOI syntax.");
  }
  if (field === "doi" && typeof value === "string" && value && evidence.length) {
    const evidenceDois = evidence
      .flatMap((item) => item.quote.match(/\b10\.\d{4,9}\/[\w.()/:+-]+/gi) ?? [])
      .map(normalizeDoi);
    if (!evidenceDois.includes(normalizeDoi(value))) {
      fieldRules = "failed";
      issues.push("The proposed DOI does not appear literally in its source evidence.");
    }
  }
  if (field === "keywords" && Array.isArray(value) && value.length && evidence.length) {
    const keywords = value.filter((item): item is string => typeof item === "string");
    const evidenceText = evidence.map((item) => item.quote).join(" ");
    const combinedEvidence = normalize(evidenceText);
    const hasKeywordLabel = /\b(?:key\s*words?|index terms)\b/i.test(evidenceText);
    const hasEmbeddedLabel = keywords.some((item) => /^(?:key\s*words?|index terms)\s*:/i.test(item.trim()));
    const missingKeywords = keywords.filter((item) => !combinedEvidence.includes(normalize(item)));
    if (!hasKeywordLabel || hasEmbeddedLabel || missingKeywords.length) {
      fieldRules = "failed";
      issues.push("Keywords must be literal values from an explicit Keywords or Index Terms source span.");
    }
  }
  if (field === "category" && typeof value === "string" && value && !(researchCategories as readonly string[]).includes(value)) {
    fieldRules = "failed";
    issues.push("Category is outside the configured RIKMS taxonomy.");
  }
  if (field === "suggested_sdgs" && Array.isArray(value)) {
    const numbers = (value as SdgSuggestion[]).map((item) => item.number);
    if (new Set(numbers).size !== numbers.length) {
      fieldRules = "failed";
      issues.push("Suggested SDGs contain duplicate goal numbers.");
    }
    const mismatchedReason = (value as SdgSuggestion[]).some((item) => {
      const mentioned = [...item.reason.matchAll(/\b(?:SDG|Goal)\s*(\d{1,2})\b/gi)].map((match) => Number(match[1]));
      return mentioned.some((number) => number !== item.number);
    });
    if (mismatchedReason) {
      fieldRules = "failed";
      issues.push("An SDG reason names a different goal number than its structured assignment.");
    }
  }
  if (groundedSummaryFields.includes(field) && typeof value === "string" && value && groundedPlainText(value).length < 30) {
    fieldRules = "failed";
    issues.push("The grounded summary is too short to be useful.");
  }
  if (groundedSummaryFields.includes(field) && typeof value === "string" && containsDocumentMarkup(value)) {
    fieldRules = "failed";
    issues.push("The grounded summary contains document markup or a source-code block instead of research prose.");
  }
  if (groundedSummaryFields.includes(field) && typeof value === "string" && value && containsModelPreamble(value)) {
    fieldRules = "failed";
    issues.push("The grounded summary contains model-facing preamble instead of direct research prose.");
  }
  if (field === "recommendations" && Array.isArray(value) && value.some((item) => typeof item !== "string" || !isRecommendation(item))) {
    fieldRules = "failed";
    issues.push("Recommendations must express supported actions, future work, or explicit recommendations rather than restating findings.");
  }
  if (/\p{Extended_Pictographic}/u.test(JSON.stringify(value))) {
    fieldRules = "failed";
    issues.push("Machine output contains emoji or decorative pictographs and must be retried without them.");
  }
  if (/\[BLOCK\s+[A-Za-z0-9_-]+\s+\|\s+PAGE\s+\d+\s+\|/i.test(JSON.stringify(value))) {
    fieldRules = "failed";
    issues.push("Model output contains internal evidence framing and must be retried or reviewed.");
  }
  if (field === "title" && typeof value === "string" && value && evidence.length) {
    const combinedEvidence = evidence.map((item) => item.quote).join(" ");
    if (tokenSimilarity(combinedEvidence, value) < 0.9) {
      fieldRules = "failed";
      issues.push("Title evidence does not cover the complete proposed title.");
    }
  }
  const evidenceStatus: ValidationReport["evidence"] = !requiresEvidence || isEmptyValue(value)
    ? "not_required"
    : evidence.length > 0 && evidence.every((item) => item.exactMatch)
      ? "passed"
      : "failed";
  if (evidenceStatus === "failed") issues.push("No exact source span supports the proposed value.");
  return { schema, fieldRules, evidence: evidenceStatus, crossSource: "not_checked", issues };
}

function parserSignal(evidence: EvidenceSpan[], pages: DocumentPage[]): number {
  if (!evidence.length) return 0;
  const byPage = new Map(pages.map((page) => [page.page, page.parseScore]));
  return evidence.reduce((sum, item) => sum + (byPage.get(item.page) ?? 0.4), 0) / evidence.length;
}

export function acceptanceScore(input: {
  validation: ValidationReport;
  evidence: EvidenceSpan[];
  parserScore: number;
  sourceAgreement: boolean | null;
  verbalizedConfidence: number;
  semanticChecked: boolean;
  semanticSupported: boolean;
  semanticScore: number;
}): number {
  let score = 0;
  if (input.validation.schema === "passed") score += 0.2;
  if (input.validation.fieldRules === "passed") score += 0.15;
  if (input.validation.evidence === "passed" || input.validation.evidence === "not_required") score += 0.22;
  score += Math.min(0.14, input.parserScore * 0.14);
  if (input.sourceAgreement === true) score += 0.09;
  else if (input.sourceAgreement === null) score += 0.04;
  score += Math.min(0.1, Math.max(0, input.verbalizedConfidence) * 0.1);
  score += input.semanticChecked ? Math.min(0.1, input.semanticScore * 0.1) : input.evidence.length ? 0.05 : 0;
  const hardFailure = input.validation.schema === "failed"
    || input.validation.fieldRules === "failed"
    || input.validation.evidence === "failed"
    || input.validation.crossSource === "conflict"
    || (input.semanticChecked && !input.semanticSupported);
  if (hardFailure) score = Math.min(score, 0.49);
  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

async function crossrefValidate(doi: string, title: string, config: LabConfig): Promise<{ status: ValidationReport["crossSource"]; issue: string | null }> {
  if (!config.crossrefEnabled || !doi) return { status: "not_checked", issue: null };
  try {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `RIKMS-Metadata-Lab/2.0${config.crossrefMailto ? ` (mailto:${config.crossrefMailto})` : ""}` };
    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return { status: "conflict", issue: `Crossref returned HTTP ${response.status} for the DOI.` };
    const payload = await response.json() as { message?: { title?: string[]; DOI?: string } };
    const externalTitle = payload.message?.title?.[0] ?? "";
    if (title && externalTitle) {
      const left = new Set(normalize(title).split(" ").filter((term) => term.length > 3));
      const right = new Set(normalize(externalTitle).split(" ").filter((term) => term.length > 3));
      const overlap = [...left].filter((term) => right.has(term)).length / Math.max(1, Math.min(left.size, right.size));
      if (overlap < 0.65) return { status: "conflict", issue: "Crossref DOI metadata does not closely match the extracted title." };
    }
    return { status: "passed", issue: null };
  } catch {
    return { status: "not_checked", issue: "Crossref verification was temporarily unavailable." };
  }
}

function baseResult(definition: FieldDefinition, provider: ProviderKey, status: FieldResult["status"], value: FieldValue): FieldResult {
  return {
    field: definition.key,
    provider,
    strategy: definition.strategy,
    status,
    value,
    method: status === "not_applicable" ? "document-type-applicability" : "none",
    evidence: [],
    rawAcceptanceScore: status === "not_applicable" ? 1 : 0,
    acceptanceScore: status === "not_applicable" ? 1 : 0,
    calibration: "uncalibrated",
    reviewPriority: status === "not_applicable" ? "low" : "high",
    attempts: 0,
    validation: { schema: "passed", fieldRules: "passed", evidence: "not_required", crossSource: "not_checked", issues: [] },
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    error: null,
  };
}

function applicable(definition: FieldDefinition, documentType: string): boolean {
  return definition.applicableTo === "all" || definition.applicableTo.includes(documentType);
}

export function abstainRejectedCandidate(field: MetadataField, rejected: FieldResult): FieldResult {
  return {
    ...rejected,
    status: "needs_review",
    value: emptyValue(field),
    method: `${rejected.method}-abstained`,
    evidence: [],
    rawAcceptanceScore: Math.min(rejected.rawAcceptanceScore, 0.49),
    acceptanceScore: Math.min(rejected.acceptanceScore, 0.49),
    reviewPriority: "high",
    validation: {
      ...rejected.validation,
      issues: [...new Set([
        ...rejected.validation.issues,
        "All machine candidates were rejected; no unsupported value was retained.",
      ])],
    },
  };
}

export function hasHardValidationFailure(validation: ValidationReport): boolean {
  return validation.schema === "failed"
    || validation.fieldRules === "failed"
    || validation.evidence === "failed"
    || validation.crossSource === "conflict";
}

async function processField(
  definition: FieldDefinition,
  provider: ProviderKey,
  input: ProcessFieldsInput,
  title: string,
): Promise<FieldResult> {
  if (!applicable(definition, input.documentType)) return baseResult(definition, provider, "not_applicable", emptyValue(definition.key));
  const deterministic = deterministicCandidate(definition.key, input.blocks, input.grobid);
  let lastResult: FieldResult | null = null;
  let bestReviewCandidate: FieldResult | null = null;
  let accumulatedInputTokens = 0;
  let accumulatedOutputTokens = 0;
  let accumulatedDuration = 0;
  for (let attempt = 1; attempt <= input.config.maximumFieldAttempts; attempt += 1) {
    let candidateBlockIds: string[] = [];
    try {
      const useDeterministic = attempt === 1 && deterministic && !isEmptyValue(deterministic.value);
      const candidateBlocks = useDeterministic ? [] : retrieveCandidateBlocks(definition, input.blocks, attempt);
      candidateBlockIds = useDeterministic
        ? deterministic.evidence.map((item) => item.blockId)
        : candidateBlocks.map((block) => block.id);
      const modelOutput = useDeterministic ? null : await extractFieldWithModel({
        provider,
        definition,
        documentType: input.documentType,
        blocks: candidateBlocks,
        attempt,
        config: input.config,
      });
      if (modelOutput) {
        accumulatedInputTokens += modelOutput.inputTokens;
        accumulatedOutputTokens += modelOutput.outputTokens;
        accumulatedDuration += modelOutput.durationMs;
      }
      const value = useDeterministic ? deterministic.value : modelOutput!.value;
      const references = useDeterministic ? deterministic.evidence : modelOutput!.evidence;
      const evidence = resolveEvidence(references, input.blocks);
      const validation = validateField(definition.key, value, evidence, definition.requiresEvidence);
      if (definition.key === "doi" && typeof value === "string" && value) {
        const crossref = await crossrefValidate(value, title, input.config);
        validation.crossSource = crossref.status;
        if (crossref.issue) validation.issues.push(crossref.issue);
      } else if (useDeterministic && deterministic?.sourceAgreement === true) validation.crossSource = "passed";
      else if (useDeterministic && deterministic?.sourceAgreement === false) validation.crossSource = "conflict";
      const semantic = definition.strategy === "grounded_summary" || definition.strategy === "classification"
        ? await verifySemanticSupport({ field: definition.key, value, evidence, config: input.config })
        : { checked: false, supported: evidence.length > 0, score: evidence.length ? 0.75 : 0, issues: [], model: null, durationMs: 0 };
      accumulatedDuration += semantic.durationMs;
      evidence.forEach((item) => {
        item.semanticSupport = semantic.checked ? semantic.supported ? "supported" : "unsupported" : "not_checked";
        item.supportScore = semantic.checked ? semantic.score : null;
      });
      if (semantic.checked && !semantic.supported) validation.issues.push(...semantic.issues, "Second-pass verifier did not find sufficient semantic support.");
      else if (!semantic.checked && semantic.issues.length) validation.issues.push(...semantic.issues);
      const rawScore = acceptanceScore({
        validation,
        evidence,
        parserScore: parserSignal(evidence, input.pages),
        sourceAgreement: useDeterministic ? deterministic?.sourceAgreement ?? null : null,
        verbalizedConfidence: useDeterministic ? 0.9 : modelOutput!.verbalizedConfidence,
        semanticChecked: semantic.checked,
        semanticSupported: semantic.supported,
        semanticScore: semantic.score,
      });
      const calibrated = input.calibrate?.(provider, definition.key, rawScore)
        ?? { score: rawScore, calibrated: false };
      const valid = validation.schema === "passed"
        && validation.fieldRules === "passed"
        && validation.evidence !== "failed"
        && validation.crossSource !== "conflict"
        && (!semantic.checked || semantic.supported);
      const hardInvalid = hasHardValidationFailure(validation);
      const score = valid ? calibrated.score : Math.min(calibrated.score, 0.49);
      const empty = isEmptyValue(value);
      const sufficientlySupported = valid && score >= 0.65;
      lastResult = {
        field: definition.key,
        provider,
        strategy: definition.strategy,
        status: empty ? "not_found" : sufficientlySupported ? "supported" : "needs_review",
        value,
        method: useDeterministic ? deterministic.method : `${definition.strategy}-model`,
        evidence,
        rawAcceptanceScore: rawScore,
        acceptanceScore: score,
        calibration: calibrated.calibrated ? "calibrated" : "uncalibrated",
        reviewPriority: empty || !valid || score < 0.55 ? "high" : score < 0.8 ? "medium" : "low",
        attempts: attempt,
        validation,
        model: useDeterministic ? null : modelOutput!.model,
        inputTokens: accumulatedInputTokens,
        outputTokens: accumulatedOutputTokens,
        durationMs: accumulatedDuration,
        error: null,
      };
      if (!empty && !hardInvalid && (!bestReviewCandidate || lastResult.acceptanceScore > bestReviewCandidate.acceptanceScore)) {
        bestReviewCandidate = lastResult;
      }
      input.onAttempt?.({
        field: definition.key,
        provider,
        attempt,
        outcome: empty ? "not_found" : sufficientlySupported ? "accepted" : "rejected",
        candidateBlockIds,
        result: lastResult,
      });
      if (sufficientlySupported && !empty) return lastResult;
      if (attempt === input.config.maximumFieldAttempts) {
        if (!empty && hardInvalid) {
          return bestReviewCandidate
            ? {
                ...bestReviewCandidate,
                attempts: attempt,
                inputTokens: accumulatedInputTokens,
                outputTokens: accumulatedOutputTokens,
                durationMs: accumulatedDuration,
              }
            : abstainRejectedCandidate(definition.key, lastResult);
        }
        return lastResult;
      }
    } catch (error) {
      lastResult = {
        ...baseResult(definition, provider, attempt === input.config.maximumFieldAttempts ? "failed" : "needs_review", deterministic?.value ?? emptyValue(definition.key)),
        method: attempt === 1 ? "primary-attempt" : "alternate-context-retry",
        attempts: attempt,
        inputTokens: accumulatedInputTokens,
        outputTokens: accumulatedOutputTokens,
        durationMs: accumulatedDuration,
        error: error instanceof Error ? error.message : "Field extraction failed.",
        validation: { schema: "failed", fieldRules: "failed", evidence: "failed", crossSource: "not_checked", issues: [error instanceof Error ? error.message : "Field extraction failed."] },
      };
      input.onAttempt?.({
        field: definition.key,
        provider,
        attempt,
        outcome: "error",
        candidateBlockIds,
        result: lastResult,
      });
      if (attempt === input.config.maximumFieldAttempts) {
        return bestReviewCandidate
          ? {
              ...bestReviewCandidate,
              attempts: attempt,
              inputTokens: accumulatedInputTokens,
              outputTokens: accumulatedOutputTokens,
              durationMs: accumulatedDuration,
            }
          : lastResult;
      }
    }
  }
  return lastResult ?? baseResult(definition, provider, "failed", emptyValue(definition.key));
}

function derivedResult(field: "evidence_pages" | "overall_confidence", provider: ProviderKey, value: FieldValue, sourceResults: FieldResult[]): FieldResult {
  const definition = fieldDefinitions.find((item) => item.key === field)!;
  return {
    ...baseResult(definition, provider, "supported", value),
    method: field === "evidence_pages" ? "derived-from-field-evidence" : "derived-acceptance-score",
    rawAcceptanceScore: field === "overall_confidence" ? Number(value) : sourceResults.length ? 1 : 0,
    acceptanceScore: field === "overall_confidence" ? Number(value) : sourceResults.length ? 1 : 0,
    reviewPriority: "low",
  };
}

export async function processAllFields(input: ProcessFieldsInput): Promise<FieldResult[]> {
  const definitions = fieldDefinitions.filter((definition) => !["evidence_pages", "overall_confidence"].includes(definition.key));
  const title = String(deterministicTitle(input.blocks, input.grobid)?.value ?? "");
  const tasks = input.providers.flatMap((provider) => definitions.map((definition) => ({ provider, definition })));
  let completed = 0;
  const results = await Promise.all(tasks.map(async ({ provider, definition }) => {
    const result = await processField(definition, provider, input, title);
    input.onResult(result);
    completed += 1;
    input.onProgress?.(completed, tasks.length, definition.key, provider);
    return result;
  }));
  for (const provider of input.providers) {
    const providerResults = results.filter((result) => result.provider === provider);
    const evidencePages = [...new Set(providerResults.flatMap((result) => result.evidence.map((evidence) => evidence.page)))].sort((left, right) => left - right);
    const scored = providerResults.filter((result) => result.status !== "not_applicable");
    const aggregate = scored.length ? Math.round((scored.reduce((sum, result) => sum + result.acceptanceScore, 0) / scored.length) * 100) / 100 : 0;
    const pagesResult = derivedResult("evidence_pages", provider, evidencePages, providerResults);
    const scoreResult = derivedResult("overall_confidence", provider, aggregate, providerResults);
    input.onResult(pagesResult);
    input.onResult(scoreResult);
    results.push(pagesResult, scoreResult);
  }
  return results;
}
