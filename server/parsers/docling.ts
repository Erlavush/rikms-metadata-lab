import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DocumentBlock } from "../contracts.js";
import type { LabConfig } from "../config.js";
import { commandVersion, resolveCommand, runCommand } from "../process.js";
import { normalizeBlockText } from "./native.js";

export type DoclingParseResult = {
  blocks: DocumentBlock[];
  version: string;
  rawJson: Record<string, unknown>;
  durationMs: number;
};

type JsonRecord = Record<string, unknown>;

let cachedDoclingCapability: { command: string; available: boolean; version: string | null } | null = null;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value) || fallback;
}

function pageDimensions(document: JsonRecord): Map<number, { width: number; height: number }> {
  const result = new Map<number, { width: number; height: number }>();
  const pages = record(document.pages);
  if (!pages) return result;
  for (const [key, value] of Object.entries(pages)) {
    const page = record(value);
    const size = record(page?.size);
    const pageNumber = Number(key) || numberValue(page?.page_no);
    if (pageNumber > 0 && size) result.set(pageNumber, { width: numberValue(size.width, 612), height: numberValue(size.height, 792) });
  }
  return result;
}

function blockType(label: string): DocumentBlock["type"] {
  const normalized = label.toLowerCase();
  if (normalized.includes("title")) return normalized.includes("section") ? "heading" : "title";
  if (normalized.includes("section_header") || normalized.includes("heading")) return "heading";
  if (normalized.includes("list")) return "list_item";
  if (normalized.includes("table")) return "table";
  if (normalized.includes("caption")) return "caption";
  if (normalized.includes("formula") || normalized.includes("equation")) return "formula";
  if (normalized.includes("footnote")) return "footnote";
  if (normalized.includes("header")) return "header";
  if (normalized.includes("footer")) return "footer";
  return "paragraph";
}

function provenance(item: JsonRecord, dimensions: Map<number, { width: number; height: number }>): { page: number; x: number; y: number; width: number; height: number } | null {
  const list = Array.isArray(item.prov) ? item.prov : [];
  const first = record(list[0]);
  if (!first) return null;
  const page = numberValue(first.page_no ?? first.page, 1);
  const bbox = record(first.bbox);
  if (!bbox) return { page, x: 0, y: 0, width: dimensions.get(page)?.width ?? 612, height: 1 };
  const left = numberValue(bbox.l ?? bbox.left ?? bbox.x);
  const right = numberValue(bbox.r ?? bbox.right, left + numberValue(bbox.w ?? bbox.width));
  const top = numberValue(bbox.t ?? bbox.top ?? bbox.y);
  const bottom = numberValue(bbox.b ?? bbox.bottom, top + numberValue(bbox.h ?? bbox.height));
  const origin = String(bbox.coord_origin ?? bbox.origin ?? "TOPLEFT").toUpperCase();
  const pageHeight = dimensions.get(page)?.height ?? Math.max(top, bottom, 792);
  return {
    page,
    x: left,
    y: origin.includes("BOTTOM") ? Math.max(0, pageHeight - Math.max(top, bottom)) : Math.min(top, bottom),
    width: Math.max(1, Math.abs(right - left)),
    height: Math.max(1, Math.abs(bottom - top)),
  };
}

export function parseDoclingJson(document: JsonRecord): DocumentBlock[] {
  const dimensions = pageDimensions(document);
  const items = [
    ...(Array.isArray(document.texts) ? document.texts : []),
    ...(Array.isArray(document.tables) ? document.tables : []),
  ];
  const pageOrder = new Map<number, number>();
  const sectionPath = new Map<number, string[]>();
  const blocks: DocumentBlock[] = [];
  for (const raw of items) {
    const item = record(raw);
    if (!item) continue;
    const text = normalizeBlockText(String(item.text ?? item.orig ?? ""));
    if (!text) continue;
    const location = provenance(item, dimensions);
    if (!location) continue;
    const order = (pageOrder.get(location.page) ?? 0) + 1;
    pageOrder.set(location.page, order);
    const type = blockType(String(item.label ?? item.type ?? "paragraph"));
    if (type === "heading") sectionPath.set(location.page, [text]);
    blocks.push({
      id: `docling-p${location.page}-${String(item.self_ref ?? order).replace(/[^A-Za-z0-9_-]/g, "_")}`,
      page: location.page,
      type,
      text,
      normalizedText: text.toLocaleLowerCase(),
      x: location.x,
      y: location.y,
      width: location.width,
      height: location.height,
      readingOrder: order,
      sectionPath: type === "heading" ? [text] : sectionPath.get(location.page) ?? [],
      sourceEngine: "docling",
      sourceConfidence: null,
      sourceIds: [String(item.self_ref ?? `docling:${location.page}:${order}`)],
    });
  }
  return blocks.sort((left, right) => left.page - right.page || left.readingOrder - right.readingOrder);
}

export async function doclingCapability(config: LabConfig): Promise<{ available: boolean; version: string | null }> {
  if (config.doclingMode === "off" || !resolveCommand(config.doclingCommand)) return { available: false, version: null };
  if (cachedDoclingCapability?.command === config.doclingCommand) {
    return { available: cachedDoclingCapability.available, version: cachedDoclingCapability.version };
  }
  // Importing Docling and Torch can exceed the generic five-second probe on a
  // cold laptop process, while conversion has its own larger hard timeout.
  const version = await commandVersion(config.doclingCommand, ["--version"], 15_000);
  cachedDoclingCapability = { command: config.doclingCommand, available: Boolean(version), version };
  return { available: Boolean(version), version };
}

export async function parseWithDocling(filePath: string, config: LabConfig): Promise<DoclingParseResult> {
  const capability = await doclingCapability(config);
  if (!capability.available) throw new Error("Docling is not available.");
  const outputDirectory = mkdtempSync(path.join(os.tmpdir(), "rikms-docling-"));
  const started = Date.now();
  try {
    await runCommand(config.doclingCommand, [
      "--from", "pdf",
      "--to", "json",
      "--pipeline", "standard",
      "--image-export-mode", "placeholder",
      "--document-timeout", String(Math.ceil(config.processTimeoutMs / 1000)),
      "--num-threads", "4",
      "--page-batch-size", "1",
      "--device", config.doclingDevice,
      "--output", outputDirectory,
      filePath,
    ], { timeoutMs: config.processTimeoutMs + 30_000, maximumOutputBytes: 1_000_000 });
    const jsonPath = readdirSync(outputDirectory)
      .filter((name) => name.toLowerCase().endsWith(".json"))
      .map((name) => path.join(outputDirectory, name))
      .find((candidate) => existsSync(candidate));
    if (!jsonPath) throw new Error("Docling completed without producing its document JSON artifact.");
    const rawJson = JSON.parse(readFileSync(jsonPath, "utf8")) as JsonRecord;
    return {
      blocks: parseDoclingJson(rawJson),
      rawJson,
      version: capability.version ?? "unknown",
      durationMs: Date.now() - started,
    };
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}
