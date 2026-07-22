import { existsSync } from "node:fs";
import path from "node:path";

export type LabConfig = {
  rootDirectory: string;
  dataDirectory: string;
  uploadDirectory: string;
  artifactDirectory: string;
  databasePath: string;
  host: string;
  port: number;
  maximumUploadBytes: number;
  maximumPages: number;
  processTimeoutMs: number;
  modelTimeoutMs: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaNumCtx: number;
  ollamaKeepAlive: string;
  apiBaseUrl: string;
  apiModel: string;
  apiKey: string;
  pdfTextCommand: string;
  pdfInfoCommand: string;
  pdfFontsCommand: string;
  pdfRenderCommand: string;
  tesseractCommand: string;
  ocrLanguages: string;
  ocrDpi: number;
  ocrThreshold: number;
  doclingCommand: string;
  doclingDevice: "auto" | "cpu" | "cuda";
  doclingMode: "off" | "auto" | "always";
  grobidBaseUrl: string;
  grobidMode: "off" | "auto" | "always";
  crossrefEnabled: boolean;
  crossrefMailto: string;
  maximumFieldAttempts: number;
  maximumEvidenceCharacters: number;
  leaseMs: number;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function mode(value: string | undefined, fallback: "off" | "auto" | "always"): "off" | "auto" | "always" {
  return ["off", "auto", "always"].includes(value ?? "") ? value as "off" | "auto" | "always" : fallback;
}

function loopbackUrl(value: string, label: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must use an absolute loopback-only URL without credentials, search parameters, or a fragment.`);
  }
  return value.replace(/\/$/, "");
}

function externalApiUrl(value: string): string {
  const url = new URL(value);
  const isLoopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(isLoopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("The comparison API must use HTTPS, or HTTP only on loopback, without credentials in the URL.");
  }
  return value.replace(/\/$/, "");
}

function loopbackHost(value: string): string {
  const host = value.trim();
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("LAB_HOST must be a loopback-only host (127.0.0.1, localhost, or ::1).");
  }
  return host;
}

export function loadLabConfig(rootDirectory = process.cwd()): LabConfig {
  const dataDirectory = path.resolve(rootDirectory, process.env.LAB_DATA_DIR ?? ".data");
  const bundledDocling = path.resolve(rootDirectory, ".venv-docling", "bin", "docling");
  const maximumUploadMb = boundedInteger(process.env.LAB_MAX_UPLOAD_MB, 25, 1, 100);
  return {
    rootDirectory,
    dataDirectory,
    uploadDirectory: path.join(dataDirectory, "uploads"),
    artifactDirectory: path.join(dataDirectory, "artifacts"),
    databasePath: path.join(dataDirectory, "lab.sqlite"),
    host: loopbackHost(process.env.LAB_HOST ?? "127.0.0.1"),
    port: boundedInteger(process.env.LAB_API_PORT, 8787, 1024, 65535),
    maximumUploadBytes: maximumUploadMb * 1024 * 1024,
    maximumPages: boundedInteger(process.env.LAB_MAX_PAGES, 500, 1, 2_000),
    processTimeoutMs: boundedInteger(process.env.PARSER_TIMEOUT_SECONDS, 240, 10, 1_800) * 1000,
    modelTimeoutMs: boundedInteger(process.env.AI_TIMEOUT_SECONDS, 240, 10, 1_800) * 1000,
    ollamaBaseUrl: loopbackUrl(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434", "Ollama"),
    ollamaModel: (process.env.OLLAMA_MODEL ?? "qwen3.5:4b").trim(),
    ollamaNumCtx: boundedInteger(process.env.OLLAMA_NUM_CTX, 16_384, 2_048, 32_768),
    ollamaKeepAlive: (process.env.OLLAMA_KEEP_ALIVE ?? "30m").trim(),
    apiBaseUrl: externalApiUrl(process.env.AI_BASE_URL ?? "https://api.openai.com/v1"),
    apiModel: (process.env.AI_MODEL ?? "").trim(),
    apiKey: (process.env.AI_API_KEY ?? "").trim(),
    pdfTextCommand: (process.env.PDFTOTEXT_COMMAND ?? "pdftotext").trim(),
    pdfInfoCommand: (process.env.PDFINFO_COMMAND ?? "pdfinfo").trim(),
    pdfFontsCommand: (process.env.PDFFONTS_COMMAND ?? "pdffonts").trim(),
    pdfRenderCommand: (process.env.PDFTOPPM_COMMAND ?? "pdftoppm").trim(),
    tesseractCommand: (process.env.TESSERACT_COMMAND ?? "tesseract").trim(),
    ocrLanguages: (process.env.OCR_LANGUAGES ?? "eng").trim(),
    ocrDpi: boundedInteger(process.env.OCR_DPI, 170, 100, 300),
    ocrThreshold: boundedNumber(process.env.OCR_PARSE_SCORE_THRESHOLD, 0.62, 0, 1),
    doclingCommand: (process.env.DOCLING_COMMAND ?? (existsSync(bundledDocling) ? bundledDocling : "docling")).trim(),
    doclingDevice: ["auto", "cpu", "cuda"].includes(process.env.DOCLING_DEVICE ?? "")
      ? process.env.DOCLING_DEVICE as "auto" | "cpu" | "cuda"
      : "auto",
    doclingMode: mode(process.env.DOCLING_MODE, "auto"),
    grobidBaseUrl: loopbackUrl(process.env.GROBID_BASE_URL ?? "http://127.0.0.1:8070", "GROBID"),
    grobidMode: mode(process.env.GROBID_MODE, "auto"),
    crossrefEnabled: process.env.CROSSREF_ENABLED === "true",
    crossrefMailto: (process.env.CROSSREF_MAILTO ?? "").trim(),
    maximumFieldAttempts: boundedInteger(process.env.FIELD_MAX_ATTEMPTS, 2, 1, 3),
    maximumEvidenceCharacters: boundedInteger(process.env.FIELD_CONTEXT_CHARACTERS, 18_000, 4_000, 60_000),
    leaseMs: boundedInteger(process.env.JOB_LEASE_SECONDS, 60, 20, 600) * 1000,
  };
}
