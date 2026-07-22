import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import type { DocumentBlock, DocumentPage } from "../contracts.js";
import type { LabConfig } from "../config.js";
import { runCommand } from "../process.js";
import { classifyDocumentLine, normalizeBlockText } from "./native.js";

export type OcrWord = {
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

function safeRunName(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
}

export async function renderPagePng(
  filePath: string,
  page: number,
  runId: string,
  config: LabConfig,
  dpi = config.ocrDpi,
): Promise<string> {
  if (!Number.isInteger(page) || page < 1 || page > config.maximumPages) throw new Error("Invalid PDF page number.");
  const runDirectory = path.join(config.artifactDirectory, safeRunName(runId), "pages");
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(runDirectory, `page-${String(page).padStart(4, "0")}-${dpi}.png`);
  if (existsSync(target)) return target;
  // Stage the render beside its final destination. `rename` is atomic only
  // within one filesystem, while /tmp is commonly a separate tmpfs mount.
  const temporary = mkdtempSync(path.join(runDirectory, ".render-"));
  try {
    const prefix = path.join(temporary, "page");
    await runCommand(config.pdfRenderCommand, [
      "-f", String(page), "-l", String(page), "-r", String(dpi), "-png", "-singlefile", filePath, prefix,
    ], { timeoutMs: config.processTimeoutMs, maximumOutputBytes: 200_000 });
    const generated = `${prefix}.png`;
    if (!existsSync(generated)) throw new Error(`Page ${page} could not be rendered for OCR.`);
    renameSync(generated, target);
    chmodSync(target, 0o600);
    return target;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function parseOcrTsv(tsv: string): { words: OcrWord[]; imageWidth: number; imageHeight: number } {
  const lines = tsv.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { words: [], imageWidth: 1, imageHeight: 1 };
  const header = lines[0].split("\t").map((item) => item.trim().toLowerCase());
  const at = (name: string, fallback: number) => Math.max(0, header.indexOf(name) >= 0 ? header.indexOf(name) : fallback);
  const column = {
    level: at("level", 0), block: at("block_num", 2), paragraph: at("par_num", 3), line: at("line_num", 4),
    word: at("word_num", 5), left: at("left", 6), top: at("top", 7), width: at("width", 8),
    height: at("height", 9), confidence: at("conf", 10), text: at("text", 11),
  };
  const words: OcrWord[] = [];
  let imageWidth = 1;
  let imageHeight = 1;
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const level = Number(cells[column.level]);
    if (level === 1) {
      imageWidth = Number(cells[column.width]) || imageWidth;
      imageHeight = Number(cells[column.height]) || imageHeight;
      continue;
    }
    const text = cells.slice(column.text).join("\t").trim();
    const confidence = Number(cells[column.confidence]);
    if (level !== 5 || !text || !Number.isFinite(confidence) || confidence < 0) continue;
    words.push({
      block: Number(cells[column.block]) || 0,
      paragraph: Number(cells[column.paragraph]) || 0,
      line: Number(cells[column.line]) || 0,
      word: Number(cells[column.word]) || 0,
      left: Number(cells[column.left]) || 0,
      top: Number(cells[column.top]) || 0,
      width: Number(cells[column.width]) || 0,
      height: Number(cells[column.height]) || 0,
      confidence,
      text,
    });
  }
  return { words, imageWidth, imageHeight };
}

async function ocrPage(filePath: string, pageInfo: DocumentPage, runId: string, config: LabConfig): Promise<{ page: DocumentPage; blocks: DocumentBlock[]; imagePath: string }> {
  const imagePath = await renderPagePng(filePath, pageInfo.page, runId, config);
  const result = await runCommand(config.tesseractCommand, [imagePath, "stdout", "-l", config.ocrLanguages, "--psm", "3", "tsv"], {
    timeoutMs: config.processTimeoutMs,
    maximumOutputBytes: 12_000_000,
  });
  const parsed = parseOcrTsv(result.stdout.toString("utf8"));
  const grouped = new Map<string, OcrWord[]>();
  parsed.words.forEach((word) => {
    const key = `${word.block}:${word.paragraph}:${word.line}`;
    grouped.set(key, [...(grouped.get(key) ?? []), word]);
  });
  const xScale = pageInfo.width / parsed.imageWidth;
  const yScale = pageInfo.height / parsed.imageHeight;
  const blocks: DocumentBlock[] = [];
  let order = 0;
  let sectionPath: string[] = [];
  for (const words of grouped.values()) {
    words.sort((left, right) => left.word - right.word || left.left - right.left);
    const text = normalizeBlockText(words.map((word) => word.text).join(" "));
    if (!text) continue;
    order += 1;
    const left = Math.min(...words.map((word) => word.left)) * xScale;
    const top = Math.min(...words.map((word) => word.top)) * yScale;
    const right = Math.max(...words.map((word) => word.left + word.width)) * xScale;
    const bottom = Math.max(...words.map((word) => word.top + word.height)) * yScale;
    const type = classifyDocumentLine(text, pageInfo.page, top, pageInfo.height, order);
    if (type === "heading") sectionPath = [text];
    blocks.push({
      id: `ocr-p${pageInfo.page}-b${words[0].block}-l${words[0].line}-${order}`,
      page: pageInfo.page,
      type,
      text,
      normalizedText: text.toLocaleLowerCase(),
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      readingOrder: order,
      sectionPath: [...sectionPath],
      sourceEngine: "tesseract-5",
      sourceConfidence: words.reduce((sum, word) => sum + word.confidence, 0) / words.length / 100,
      sourceIds: [`tesseract:${pageInfo.page}:${words[0].block}:${words[0].paragraph}:${words[0].line}`],
    });
  }
  const text = blocks.filter((block) => !["header", "footer"].includes(block.type)).map((block) => block.text).join("\n");
  const meanConfidence = parsed.words.length ? parsed.words.reduce((sum, word) => sum + word.confidence, 0) / parsed.words.length / 100 : 0;
  const characters = text.replace(/\s/g, "").length;
  const parseScore = Math.max(0, Math.min(1, meanConfidence * 0.72 + Math.min(1, characters / 1_000) * 0.28));
  const grade: DocumentPage["grade"] = parseScore >= 0.9 ? "excellent" : parseScore >= 0.72 ? "good" : parseScore >= 0.48 ? "fair" : "poor";
  return {
    imagePath,
    blocks,
    page: {
      ...pageInfo,
      nativeCharacters: pageInfo.nativeCharacters,
      nativeWords: pageInfo.nativeWords,
      parseScore,
      grade,
      reasons: [...pageInfo.reasons, `selective-ocr-${grade}`],
      ocrApplied: true,
      sourceEngine: "tesseract-5",
      text,
    },
  };
}

export async function applySelectiveOcr(
  filePath: string,
  pages: DocumentPage[],
  blocks: DocumentBlock[],
  runId: string,
  config: LabConfig,
): Promise<{ pages: DocumentPage[]; blocks: DocumentBlock[]; renderedPages: Array<{ page: number; imagePath: string }> }> {
  const nextPages = [...pages];
  let nextBlocks = [...blocks];
  const renderedPages: Array<{ page: number; imagePath: string }> = [];
  for (const pageInfo of pages) {
    const needsOcr = pageInfo.parseScore < config.ocrThreshold || pageInfo.reasons.includes("too-little-native-text");
    if (!needsOcr) continue;
    const result = await ocrPage(filePath, pageInfo, runId, config);
    renderedPages.push({ page: pageInfo.page, imagePath: result.imagePath });
    const ocrCharacters = result.page.text.replace(/\s/g, "").length;
    const useOcr = ocrCharacters > Math.max(40, pageInfo.nativeCharacters * 0.7) && result.page.parseScore >= pageInfo.parseScore;
    if (!useOcr) {
      const index = nextPages.findIndex((page) => page.page === pageInfo.page);
      nextPages[index] = { ...pageInfo, ocrApplied: true, reasons: [...pageInfo.reasons, "ocr-did-not-improve-page"] };
      continue;
    }
    nextBlocks = nextBlocks.filter((block) => block.page !== pageInfo.page).concat(result.blocks);
    const index = nextPages.findIndex((page) => page.page === pageInfo.page);
    nextPages[index] = result.page;
  }
  nextBlocks.sort((left, right) => left.page - right.page || left.readingOrder - right.readingOrder);
  return { pages: nextPages, blocks: nextBlocks, renderedPages };
}

export function readRenderedPage(filePath: string): Buffer {
  return readFileSync(filePath);
}
