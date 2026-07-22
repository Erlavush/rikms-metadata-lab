import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DocumentBlock, DocumentPage, ParserCapability } from "./contracts.js";
import type { LabConfig } from "./config.js";
import { commandVersion, resolveCommand } from "./process.js";
import { doclingCapability, parseWithDocling, type DoclingParseResult } from "./parsers/docling.js";
import { grobidCapability, parseWithGrobid, type GrobidParseResult } from "./parsers/grobid.js";
import { parseNativePdf, type PdfInventory } from "./parsers/native.js";
import { applySelectiveOcr } from "./parsers/ocr.js";

export type HybridDocument = {
  inventory: PdfInventory;
  pages: DocumentPage[];
  blocks: DocumentBlock[];
  documentType: string;
  language: string;
  methods: string[];
  capabilities: ParserCapability[];
  grobid: GrobidParseResult | null;
  docling: DoclingParseResult | null;
  artifactPaths: Array<{ type: string; path: string; version: string }>;
};

function artifactRunDirectory(runId: string, config: LabConfig): string {
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  const directory = path.join(config.artifactDirectory, safe);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function writePrivateArtifact(directory: string, name: string, content: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}

function pageText(blocks: DocumentBlock[], page: number): string {
  return blocks
    .filter((block) => block.page === page && !["header", "footer"].includes(block.type))
    .sort((left, right) => left.readingOrder - right.readingOrder)
    .map((block) => block.text)
    .join("\n");
}

export function mergeDocling(
  nativePages: DocumentPage[],
  nativeBlocks: DocumentBlock[],
  docling: DoclingParseResult,
  complexPages: number[],
  mode: LabConfig["doclingMode"],
): { pages: DocumentPage[]; blocks: DocumentBlock[]; adoptedPages: number[] } {
  const pages = [...nativePages];
  let blocks = [...nativeBlocks];
  const adoptedPages: number[] = [];
  for (const page of nativePages) {
    const doclingBlocks = docling.blocks.filter((block) => block.page === page.page);
    if (!doclingBlocks.length) continue;
    const nativePageBlocks = nativeBlocks.filter((block) => block.page === page.page);
    const nativeCharacters = page.text.replace(/\s/g, "").length;
    const doclingText = pageText(docling.blocks, page.page);
    const doclingCharacters = doclingText.replace(/\s/g, "").length;
    const shouldUse = mode === "always" || page.parseScore < 0.72 || complexPages.includes(page.page);
    const structuralBlocks = doclingBlocks.filter((block) => !["paragraph", "header", "footer"].includes(block.type));
    const preservesSegmentation = nativePageBlocks.length <= 2
      || doclingBlocks.length >= Math.max(2, Math.ceil(nativePageBlocks.length * 0.35))
      || structuralBlocks.length >= 2;
    if (!shouldUse || !preservesSegmentation || doclingCharacters < Math.max(40, nativeCharacters * 0.65)) continue;
    blocks = blocks.filter((block) => block.page !== page.page).concat(doclingBlocks);
    adoptedPages.push(page.page);
    const index = pages.findIndex((candidate) => candidate.page === page.page);
    const improvedScore = Math.max(page.parseScore, Math.min(0.96, 0.62 + Math.min(0.34, doclingCharacters / 4_000)));
    pages[index] = {
      ...page,
      parseScore: improvedScore,
      grade: improvedScore >= 0.9 ? "excellent" : improvedScore >= 0.72 ? "good" : "fair",
      reasons: [...page.reasons, "layout-enriched-by-docling"],
      sourceEngine: "docling",
      text: doclingText,
    };
  }
  return {
    pages,
    blocks: blocks.sort((left, right) => left.page - right.page || left.readingOrder - right.readingOrder),
    adoptedPages,
  };
}

function looksLikeSplitNumberedHeading(previous: DocumentBlock | undefined, current: DocumentBlock): boolean {
  if (!previous || previous.page !== current.page || current.type !== "paragraph") return false;
  if (!/^\d+(?:\.\d+)*$/.test(previous.text.trim())) return false;
  const text = current.text.trim();
  const words = text.split(/\s+/);
  const letters = [...text].filter((character) => /[A-Za-z]/.test(character)).length;
  return words.length >= 2
    && words.length <= 12
    && letters >= 8
    && /^[A-Z]/.test(text)
    && !/[.!?;:=]$/.test(text)
    && !/[∫∑√∞≤≥≈≠]/.test(text);
}

export function propagateSectionPaths(blocks: DocumentBlock[]): DocumentBlock[] {
  let currentSection: string[] = [];
  const ordered = [...blocks].sort((left, right) => left.page - right.page || left.readingOrder - right.readingOrder);
  return ordered.map((block, index) => {
      const splitHeading = looksLikeSplitNumberedHeading(ordered[index - 1], block);
      const type = splitHeading ? "heading" : block.type;
      if (type === "heading") {
        currentSection = [splitHeading ? `${ordered[index - 1].text.trim()} ${block.text}` : block.text];
      }
      return { ...block, type, sectionPath: [...currentSection] };
    });
}

export function detectDocumentType(blocks: DocumentBlock[], grobid: GrobidParseResult | null): { documentType: string; language: string } {
  const firstPages = blocks.filter((block) => block.page <= 5).map((block) => block.text).join("\n").slice(0, 60_000);
  const normalized = firstPages.toLocaleLowerCase();
  let documentType = "unknown";
  if (/\b(research|project) proposal\b|proposal (?:submitted|presented) to/.test(normalized)) documentType = "research_proposal";
  else if (/\bdoctoral dissertation\b|\bdissertation submitted\b/.test(normalized)) documentType = "dissertation";
  else if (/\bmaster'?s thesis\b|\bundergraduate thesis\b|\bthesis submitted\b/.test(normalized)) documentType = "thesis";
  else if (/\bcapstone (?:project|paper)\b/.test(normalized)) documentType = "capstone";
  else if (/\btechnical report\b|\bresearch report\b/.test(normalized)) documentType = "technical_report";
  else if (grobid?.metadata.doi || (/\babstract\b/.test(normalized) && /\breferences\b/.test(normalized))) documentType = "journal_article";
  const latin = [...firstPages].filter((character) => /[A-Za-z]/.test(character)).length;
  const nonAsciiLetters = [...firstPages].filter((character) => character.charCodeAt(0) > 127 && /\p{L}/u.test(character)).length;
  const language = latin >= nonAsciiLetters * 4 ? "en" : "und";
  return { documentType, language };
}

export async function inspectParserCapabilities(config: LabConfig): Promise<ParserCapability[]> {
  const [nativeVersion, tesseractVersion, docling, grobid] = await Promise.all([
    commandVersion(config.pdfTextCommand, ["-v"]),
    commandVersion(config.tesseractCommand, ["--version"]),
    doclingCapability(config),
    grobidCapability(config),
  ]);
  return [
    { name: "native", configured: Boolean(resolveCommand(config.pdfTextCommand)), reachable: Boolean(nativeVersion), version: nativeVersion, role: "Fast layout-aware PDF text and coordinates" },
    { name: "tesseract", configured: Boolean(resolveCommand(config.tesseractCommand)), reachable: Boolean(tesseractVersion), version: tesseractVersion, role: "Selective OCR for affected pages" },
    { name: "docling", configured: config.doclingMode !== "off", reachable: docling.available, version: docling.version, role: "Layout and structural enrichment" },
    { name: "grobid", configured: config.grobidMode !== "off", reachable: grobid.available, version: grobid.version, role: "Scholarly metadata and section specialist" },
  ];
}

export async function buildHybridDocument(
  filePath: string,
  runId: string,
  config: LabConfig,
  onEvent?: (stage: string, message: string, details?: Record<string, unknown>) => void,
): Promise<HybridDocument> {
  onEvent?.("primary_parsing", "Running native page-aware parsing");
  const native = await parseNativePdf(filePath, config);
  const artifactDirectory = artifactRunDirectory(runId, config);
  const [doclingCapabilityResult, grobidCapabilityResult] = await Promise.all([
    doclingCapability(config),
    grobidCapability(config),
  ]);
  const shouldRunDocling = doclingCapabilityResult.available && (
    config.doclingMode === "always" || native.layoutComplexPages.length > 0 || native.pages.some((page) => page.parseScore < 0.72)
  );
  onEvent?.("quality_assessment", "Assessed native parsing quality for every page", {
    pageCount: native.inventory.pages,
    poorPages: native.pages.filter((page) => page.grade === "poor").map((page) => page.page),
    complexPages: native.layoutComplexPages,
  });
  const [doclingOutcome, grobidOutcome] = await Promise.allSettled([
    shouldRunDocling ? parseWithDocling(filePath, config) : Promise.resolve(null),
    grobidCapabilityResult.available ? parseWithGrobid(filePath, config) : Promise.resolve(null),
  ]);
  const docling = doclingOutcome.status === "fulfilled" ? doclingOutcome.value : null;
  const grobid = grobidOutcome.status === "fulfilled" ? grobidOutcome.value : null;
  if (doclingOutcome.status === "rejected") onEvent?.("parser_fallback", "Docling was unavailable for this run; native parsing remained authoritative", { error: String(doclingOutcome.reason) });
  if (grobidOutcome.status === "rejected") onEvent?.("parser_fallback", "GROBID was unavailable for this run; field extractors will use canonical blocks", { error: String(grobidOutcome.reason) });
  let pages = native.pages;
  let blocks = native.blocks;
  const methods = ["poppler-tsv"];
  const artifactPaths: Array<{ type: string; path: string; version: string }> = [];
  if (docling) {
    const merged = mergeDocling(pages, blocks, docling, native.layoutComplexPages, config.doclingMode);
    pages = merged.pages;
    blocks = merged.blocks;
    artifactPaths.push({
      type: "docling_document",
      path: writePrivateArtifact(artifactDirectory, "docling-document.json", JSON.stringify(docling.rawJson)),
      version: docling.version,
    });
    if (merged.adoptedPages.length) {
      methods.push("docling");
      onEvent?.("layout_enrichment", "Docling enriched affected layout-complex pages", { pages: merged.adoptedPages });
    } else {
      onEvent?.("parser_fallback", "Docling completed but did not improve canonical page structure; native blocks remained authoritative");
    }
  }
  onEvent?.("selective_ocr", "Routing only low-quality pages through OCR");
  const ocr = await applySelectiveOcr(filePath, pages, blocks, runId, config);
  pages = ocr.pages;
  blocks = propagateSectionPaths(ocr.blocks);
  if (ocr.renderedPages.length) methods.push("tesseract-selective-ocr");
  ocr.renderedPages.forEach((rendered) => artifactPaths.push({ type: `page_render_${rendered.page}`, path: rendered.imagePath, version: `dpi-${config.ocrDpi}` }));
  if (grobid) {
    methods.push("grobid");
    artifactPaths.push({
      type: "grobid_tei",
      path: writePrivateArtifact(artifactDirectory, "grobid.tei.xml", grobid.tei),
      version: grobid.version,
    });
    onEvent?.("scholarly_parsing", "GROBID supplied scholarly metadata candidates and section structure");
  }
  const classification = detectDocumentType(blocks, grobid);
  const capabilities = await inspectParserCapabilities(config);
  return {
    inventory: native.inventory,
    pages,
    blocks,
    documentType: classification.documentType,
    language: classification.language,
    methods,
    capabilities,
    grobid,
    docling,
    artifactPaths,
  };
}
