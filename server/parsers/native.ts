import type { DocumentBlock, DocumentPage } from "../contracts.js";
import type { LabConfig } from "../config.js";
import { runCommand } from "../process.js";

export type PdfInventory = {
  pages: number;
  encrypted: boolean;
  tagged: boolean;
  pdfVersion: string | null;
  pageWidth: number | null;
  pageHeight: number | null;
  hasEmbeddedFonts: boolean;
};

export type NativeParseResult = {
  inventory: PdfInventory;
  pages: DocumentPage[];
  blocks: DocumentBlock[];
  layoutComplexPages: number[];
  durationMs: number;
};

type TsvWord = {
  page: number;
  block: number;
  paragraph: number;
  line: number;
  word: number;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
  text: string;
};

function parseBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase().startsWith("yes") ?? false;
}

function parsePageSize(value: string | undefined): { width: number | null; height: number | null } {
  const match = value?.match(/([\d.]+)\s+x\s+([\d.]+)\s+pts/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: null, height: null };
}

export async function inspectPdf(filePath: string, config: LabConfig): Promise<PdfInventory> {
  const [infoResult, fontsResult] = await Promise.all([
    runCommand(config.pdfInfoCommand, [filePath], { timeoutMs: Math.min(config.processTimeoutMs, 30_000), maximumOutputBytes: 200_000 }),
    runCommand(config.pdfFontsCommand, [filePath], { timeoutMs: Math.min(config.processTimeoutMs, 30_000), maximumOutputBytes: 500_000 }).catch(() => null),
  ]);
  const properties = new Map<string, string>();
  for (const line of infoResult.stdout.toString("utf8").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) properties.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const pages = Number.parseInt(properties.get("Pages") ?? "0", 10);
  if (!Number.isFinite(pages) || pages < 1) throw new Error("The PDF does not contain any readable pages.");
  if (pages > config.maximumPages) throw new Error(`The PDF contains ${pages} pages; the configured limit is ${config.maximumPages}.`);
  const encrypted = parseBoolean(properties.get("Encrypted"));
  if (encrypted) throw new Error("Encrypted or password-protected PDFs must be unlocked before extraction.");
  const size = parsePageSize(properties.get("Page size"));
  const fontLines = fontsResult?.stdout.toString("utf8").split(/\r?\n/).slice(2).filter((line) => line.trim()) ?? [];
  return {
    pages,
    encrypted,
    tagged: parseBoolean(properties.get("Tagged")),
    pdfVersion: properties.get("PDF version") ?? null,
    pageWidth: size.width,
    pageHeight: size.height,
    hasEmbeddedFonts: fontLines.length > 0,
  };
}

function parseTsv(tsv: string): { words: TsvWord[]; dimensions: Map<number, { width: number; height: number }> } {
  const lines = tsv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { words: [], dimensions: new Map() };
  const header = lines[0].split("\t").map((item) => item.trim().toLowerCase());
  const index = (name: string, fallback: number) => {
    const found = header.indexOf(name);
    return found >= 0 ? found : fallback;
  };
  const columns = {
    level: index("level", 0),
    page: index("page_num", 1),
    block: index("block_num", 2),
    paragraph: index("par_num", 3),
    line: index("line_num", 4),
    word: index("word_num", 5),
    left: index("left", 6),
    top: index("top", 7),
    width: index("width", 8),
    height: index("height", 9),
    confidence: index("conf", 10),
    text: index("text", 11),
  };
  const words: TsvWord[] = [];
  const dimensions = new Map<number, { width: number; height: number }>();
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const level = Number(cells[columns.level]);
    const page = Number(cells[columns.page]);
    if (!Number.isFinite(page) || page < 1) continue;
    if (level === 1) {
      dimensions.set(page, { width: Number(cells[columns.width]) || 612, height: Number(cells[columns.height]) || 792 });
      continue;
    }
    const text = cells.slice(columns.text).join("\t").trim();
    if (level !== 5 || !text) continue;
    words.push({
      page,
      block: Number(cells[columns.block]) || 0,
      paragraph: Number(cells[columns.paragraph]) || 0,
      line: Number(cells[columns.line]) || 0,
      word: Number(cells[columns.word]) || 0,
      left: Number(cells[columns.left]) || 0,
      top: Number(cells[columns.top]) || 0,
      width: Number(cells[columns.width]) || 0,
      height: Number(cells[columns.height]) || 0,
      confidence: Number(cells[columns.confidence]) || 100,
      text,
    });
  }
  return { words, dimensions };
}

export function normalizeBlockText(text: string): string {
  return text.replaceAll("\0", "").replace(/\s+/g, " ").trim();
}

const headingTerms = /^(abstract|keywords?|introduction|background|review of related|related literature|literature review|theoretical|conceptual|method(?:ology|s)?|research design|results?|findings?|discussion|conclusions?|recommendations?|references|bibliography|appendix|executive summary)\b/i;

export function classifyDocumentLine(text: string, page: number, top: number, pageHeight: number, order: number): DocumentBlock["type"] {
  const normalized = normalizeBlockText(text);
  if (page === 1 && order <= 3 && top < pageHeight * 0.3 && normalized.length >= 8 && normalized.length <= 500) return "title";
  if (top < pageHeight * 0.035 && page > 1) return "header";
  if (top > pageHeight * 0.95) return "footer";
  const words = normalized.split(/\s+/);
  const uppercaseLetters = [...normalized].filter((character) => /[A-Z]/.test(character)).length;
  const letters = [...normalized].filter((character) => /[A-Za-z]/.test(character)).length;
  const uppercaseRatio = letters ? uppercaseLetters / letters : 0;
  const titleCaseWords = words.filter((word) => /^(?:[A-Z][\p{L}\p{N}'’/-]*|a|an|and|as|at|by|for|from|in|of|on|or|the|to|with)$/u.test(word)).length;
  const titleCaseRatio = titleCaseWords / Math.max(1, words.length);
  const looksNumbered = /^\d+(?:\.\d+)*[.)]?\s+\p{L}/u.test(normalized);
  const hasLexicalHeadingContent = letters >= 6 && words.some((word) => /\p{L}{3,}/u.test(word));
  if (
    headingTerms.test(normalized.replace(/^\d+(?:\.\d+)*[.)]?\s*/, "")) ||
    (words.length <= 14 && normalized.length <= 160 && (
      (uppercaseRatio > 0.72 && hasLexicalHeadingContent) ||
      (looksNumbered && hasLexicalHeadingContent) ||
      (words.length >= 2
        && words.length <= 10
        && hasLexicalHeadingContent
        && titleCaseRatio >= 0.8
        && !/[.!?;:=]$/.test(normalized)
        && !/\b(?:a|an|and|as|at|by|for|from|in|of|on|or|the|to|with)$/i.test(normalized))
    ))
  ) return "heading";
  if (/^[•●▪◦*-]\s+/.test(normalized) || /^\d+[.)]\s+/.test(normalized)) return "list_item";
  if (/^(table|figure|fig\.)\s+\d+/i.test(normalized)) return "caption";
  return "paragraph";
}

function qualityForPage(page: number, text: string, wordCount: number, hasEmbeddedFonts: boolean): Pick<DocumentPage, "nativeCharacters" | "nativeWords" | "replacementRatio" | "parseScore" | "grade" | "reasons"> {
  const characters = text.replace(/\s/g, "").length;
  const replacements = (text.match(/�/g) ?? []).length;
  const replacementRatio = characters ? replacements / characters : 0;
  const reasons: string[] = [];
  let score = Math.min(1, characters / 1_200) * 0.55 + Math.min(1, wordCount / 180) * 0.35 + (hasEmbeddedFonts ? 0.1 : 0);
  if (characters < 80 || wordCount < 15) reasons.push("too-little-native-text");
  if (!hasEmbeddedFonts) reasons.push("no-embedded-fonts-detected");
  if (replacementRatio > 0.01) {
    reasons.push("high-replacement-character-rate");
    score -= Math.min(0.35, replacementRatio * 4);
  }
  score = Math.max(0, Math.min(1, score));
  const grade: DocumentPage["grade"] = score >= 0.9 ? "excellent" : score >= 0.72 ? "good" : score >= 0.48 ? "fair" : "poor";
  return { nativeCharacters: characters, nativeWords: wordCount, replacementRatio, parseScore: score, grade, reasons: reasons.length ? reasons : [`native-page-${page}-healthy`] };
}

function detectLayoutComplexity(blocks: DocumentBlock[], pageWidth: number): boolean {
  const content = blocks.filter((block) => block.type === "paragraph" && block.text.length > 25);
  if (content.length < 8) return false;
  const left = content.filter((block) => block.x + block.width <= pageWidth * 0.58);
  const right = content.filter((block) => block.x >= pageWidth * 0.42);
  return left.length >= 3 && right.length >= 3;
}

export async function parseNativePdf(filePath: string, config: LabConfig): Promise<NativeParseResult> {
  const started = Date.now();
  const inventory = await inspectPdf(filePath, config);
  const result = await runCommand(config.pdfTextCommand, ["-tsv", "-enc", "UTF-8", filePath, "-"], {
    timeoutMs: config.processTimeoutMs,
    maximumOutputBytes: 15_000_000,
  });
  const { words, dimensions } = parseTsv(result.stdout.toString("utf8"));
  const grouped = new Map<string, TsvWord[]>();
  for (const word of words) {
    const key = `${word.page}:${word.block}:${word.paragraph}:${word.line}`;
    grouped.set(key, [...(grouped.get(key) ?? []), word]);
  }
  const pageOrders = new Map<number, number>();
  const sectionPaths = new Map<number, string[]>();
  const blocks: DocumentBlock[] = [];
  for (const lineWords of grouped.values()) {
    lineWords.sort((left, right) => left.word - right.word || left.left - right.left);
    const first = lineWords[0];
    const dimension = dimensions.get(first.page) ?? { width: inventory.pageWidth ?? 612, height: inventory.pageHeight ?? 792 };
    const order = (pageOrders.get(first.page) ?? 0) + 1;
    pageOrders.set(first.page, order);
    const left = Math.min(...lineWords.map((word) => word.left));
    const top = Math.min(...lineWords.map((word) => word.top));
    const right = Math.max(...lineWords.map((word) => word.left + word.width));
    const bottom = Math.max(...lineWords.map((word) => word.top + word.height));
    const text = normalizeBlockText(lineWords.map((word) => word.text).join(" "));
    const type = classifyDocumentLine(text, first.page, top, dimension.height, order);
    if (type === "heading") sectionPaths.set(first.page, [text]);
    const sectionPath = type === "heading" ? [text] : sectionPaths.get(first.page) ?? [];
    blocks.push({
      id: `native-p${first.page}-b${first.block}-l${first.line}-${order}`,
      page: first.page,
      type,
      text,
      normalizedText: text.toLocaleLowerCase(),
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      readingOrder: order,
      sectionPath,
      sourceEngine: "poppler-tsv",
      sourceConfidence: lineWords.reduce((sum, word) => sum + word.confidence, 0) / lineWords.length / 100,
      sourceIds: [`poppler:${first.page}:${first.block}:${first.paragraph}:${first.line}`],
    });
  }
  blocks.sort((left, right) => left.page - right.page || left.readingOrder - right.readingOrder);
  const pages: DocumentPage[] = [];
  const layoutComplexPages: number[] = [];
  for (let page = 1; page <= inventory.pages; page += 1) {
    const pageBlocks = blocks.filter((block) => block.page === page && !["header", "footer"].includes(block.type));
    const dimension = dimensions.get(page) ?? { width: inventory.pageWidth ?? 612, height: inventory.pageHeight ?? 792 };
    const text = pageBlocks.map((block) => block.text).join("\n");
    const pageWords = words.filter((word) => word.page === page).length;
    const quality = qualityForPage(page, text, pageWords, inventory.hasEmbeddedFonts);
    if (detectLayoutComplexity(pageBlocks, dimension.width)) {
      layoutComplexPages.push(page);
      quality.reasons.push("multi-column-or-layout-complex");
    }
    pages.push({
      page,
      width: dimension.width,
      height: dimension.height,
      ...quality,
      ocrApplied: false,
      sourceEngine: "poppler-tsv",
      text,
    });
  }
  return { inventory, pages, blocks, layoutComplexPages, durationMs: Date.now() - started };
}
