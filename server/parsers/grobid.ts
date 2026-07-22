import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LabConfig } from "../config.js";

export type GrobidSection = {
  heading: string;
  text: string;
  page: number | null;
};

export type GrobidMetadata = {
  title: string;
  authors: string[];
  abstract: string;
  keywords: string[];
  doi: string;
  sections: GrobidSection[];
};

export type GrobidParseResult = {
  version: string;
  metadata: GrobidMetadata;
  tei: string;
  durationMs: number;
};

function decodeXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(value: string, expression: RegExp): string {
  return decodeXml(value.match(expression)?.[1] ?? "");
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function pageFromCoordinates(fragment: string): number | null {
  const match = fragment.match(/\bcoords="(\d+),/i);
  return match ? Number(match[1]) : null;
}

export function parseGrobidTei(tei: string): GrobidMetadata {
  const header = tei.match(/<teiHeader\b[^>]*>([\s\S]*?)<\/teiHeader>/i)?.[1] ?? tei;
  const titleStatement = tei.match(/<titleStmt\b[^>]*>([\s\S]*?)<\/titleStmt>/i)?.[1] ?? "";
  const title = firstMatch(titleStatement, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const analytic = header.match(/<analytic\b[^>]*>([\s\S]*?)<\/analytic>/i)?.[1] ?? titleStatement;
  const authorFragments = [...analytic.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].map((match) => match[1]);
  const authors = unique(authorFragments.map((fragment) => {
    const forenames = [...fragment.matchAll(/<forename\b[^>]*>([\s\S]*?)<\/forename>/gi)].map((match) => decodeXml(match[1]));
    const surname = firstMatch(fragment, /<surname\b[^>]*>([\s\S]*?)<\/surname>/i);
    return [...forenames, surname].filter(Boolean).join(" ");
  }));
  const abstract = firstMatch(tei, /<abstract\b[^>]*>([\s\S]*?)<\/abstract>/i);
  const keywordArea = tei.match(/<keywords\b[^>]*>([\s\S]*?)<\/keywords>/i)?.[1] ?? "";
  const keywordTerms = [...keywordArea.matchAll(/<term\b[^>]*>([\s\S]*?)<\/term>/gi)].map((match) => decodeXml(match[1]));
  const keywords = unique(keywordTerms.length ? keywordTerms : decodeXml(keywordArea).split(/[;,]/));
  // Only the TEI header describes the uploaded work. Full-text TEI also
  // contains DOI elements for bibliography entries, which must never be
  // promoted to document metadata.
  const doi = firstMatch(header, /<idno\b[^>]*type="DOI"[^>]*>([\s\S]*?)<\/idno>/i);
  const sections: GrobidSection[] = [];
  for (const match of tei.matchAll(/<div\b[^>]*>([\s\S]*?)<\/div>/gi)) {
    const fragment = match[1];
    const heading = firstMatch(fragment, /<head\b[^>]*>([\s\S]*?)<\/head>/i);
    const paragraphs = [...fragment.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((paragraph) => decodeXml(paragraph[1]));
    const text = paragraphs.join("\n").trim();
    if (heading || text) sections.push({ heading, text, page: pageFromCoordinates(fragment) });
  }
  return { title, authors, abstract, keywords, doi, sections };
}

export async function grobidCapability(config: LabConfig): Promise<{ available: boolean; version: string | null }> {
  if (config.grobidMode === "off") return { available: false, version: null };
  try {
    const health = await fetch(`${config.grobidBaseUrl}/api/isalive`, { signal: AbortSignal.timeout(1_500) });
    if (!health.ok || !(await health.text()).trim().toLowerCase().includes("true")) return { available: false, version: null };
    const versionResponse = await fetch(`${config.grobidBaseUrl}/api/version`, { signal: AbortSignal.timeout(1_500) });
    const versionText = versionResponse.ok ? (await versionResponse.text()).trim().slice(0, 500) : "";
    let version = versionText || "unknown";
    try {
      const parsed = JSON.parse(versionText) as { version?: unknown; revision?: unknown };
      if (typeof parsed.version === "string") {
        version = typeof parsed.revision === "string" ? `${parsed.version}+${parsed.revision}` : parsed.version;
      }
    } catch {
      // Older GROBID versions return plain text.
    }
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

export async function parseWithGrobid(filePath: string, config: LabConfig): Promise<GrobidParseResult> {
  const capability = await grobidCapability(config);
  if (!capability.available) throw new Error("GROBID is not reachable.");
  const started = Date.now();
  const bytes = await readFile(filePath);
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const form = new FormData();
    form.append("input", new Blob([bytes], { type: "application/pdf" }), path.basename(filePath));
    form.append("consolidateHeader", "0");
    form.append("consolidateCitations", "0");
    for (const coordinateType of ["title", "persName", "head", "p", "figure", "formula"]) {
      form.append("teiCoordinates", coordinateType);
    }
    response = await fetch(`${config.grobidBaseUrl}/api/processFulltextDocument`, {
      method: "POST",
      headers: { accept: "application/xml" },
      body: form,
      signal: AbortSignal.timeout(config.processTimeoutMs),
    });
    if (response.status !== 503 || attempt === 3) break;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  if (!response) throw new Error("GROBID parsing did not produce a response.");
  if (!response.ok) throw new Error(`GROBID parsing failed with HTTP ${response.status}.`);
  const tei = await response.text();
  if (tei.length > 20_000_000) throw new Error("GROBID output exceeded the 20 MB safety limit.");
  return {
    version: capability.version ?? "unknown",
    metadata: parseGrobidTei(tei),
    tei,
    durationMs: Date.now() - started,
  };
}
