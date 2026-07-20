import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { ZodError, z } from "zod";
import { LabDatabase } from "./database.js";
import {
  extractPdfText,
  loadLabConfig,
  runApiModel,
  runOllama,
  type ProviderKey,
} from "./extraction.js";

const root = process.cwd();
const dataDirectory = path.resolve(root, process.env.LAB_DATA_DIR ?? ".data");
const uploadDirectory = path.join(dataDirectory, "uploads");
mkdirSync(uploadDirectory, { recursive: true, mode: 0o700 });

const database = new LabDatabase(path.join(dataDirectory, "lab.sqlite"));
const config = loadLabConfig();
const host = process.env.LAB_HOST ?? "127.0.0.1";
const port = Math.max(1024, Math.min(65535, Number.parseInt(process.env.LAB_API_PORT ?? "8787", 10)));
const maximumUploadBytes = Math.max(1, Math.min(25, Number.parseInt(process.env.LAB_MAX_UPLOAD_MB ?? "25", 10))) * 1024 * 1024;

const storage = multer.diskStorage({
  destination: uploadDirectory,
  filename: (_request, _file, callback) => callback(null, `${randomUUID()}.pdf`),
});
const upload = multer({
  storage,
  limits: { fileSize: maximumUploadBytes, files: 1 },
  fileFilter: (_request, file, callback) => {
    const extensionIsPdf = path.extname(file.originalname).toLowerCase() === ".pdf";
    const mimeIsPdf = ["application/pdf", "application/octet-stream"].includes(file.mimetype);
    callback(extensionIsPdf && mimeIsPdf ? null : new Error("Only PDF files are accepted."), extensionIsPdf && mimeIsPdf);
  },
});

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && ["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "OPTIONS") return response.sendStatus(204);
  next();
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, database: "sqlite", ollamaModel: config.ollamaModel });
});

app.get("/api/config", async (_request, response) => {
  let ollamaReachable = false;
  try {
    const check = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
    ollamaReachable = check.ok;
  } catch {
    ollamaReachable = false;
  }
  response.json({
    maxUploadMb: maximumUploadBytes / 1024 / 1024,
    providers: {
      ollama: { configured: true, reachable: ollamaReachable, model: config.ollamaModel },
      api: { configured: Boolean(config.apiKey && config.apiModel), reachable: null, model: config.apiModel || "Not configured" },
    },
  });
});

app.get("/api/extractions", (request, response) => {
  const limit = Number.parseInt(String(request.query.limit ?? "30"), 10);
  response.json({ extractions: database.list(limit) });
});

app.get("/api/extractions/:id", (request, response) => {
  const record = database.get(request.params.id);
  if (!record) return response.status(404).json({ error: "Extraction not found." });
  response.json(record);
});

const scoreValidator = z.object({
  scores: z.record(z.string(), z.enum(["correct", "partial", "incorrect"])),
});

app.patch("/api/extractions/:id/scores", (request, response) => {
  const record = database.get(request.params.id);
  if (!record) return response.status(404).json({ error: "Extraction not found." });
  const parsed = scoreValidator.parse(request.body);
  database.update(record.id, { scores: parsed.scores });
  response.json(database.get(record.id));
});

const selectedProvidersValidator = z.array(z.enum(["ollama", "api"])).min(1).max(2);

app.post("/api/extractions", upload.single("paper"), (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ error: "Choose a PDF to extract." });
    chmodSync(request.file.path, 0o600);
    const signature = readFileSync(request.file.path).subarray(0, 5).toString("ascii");
    if (signature !== "%PDF-") {
      unlinkSync(request.file.path);
      return response.status(422).json({ error: "The selected file does not have a valid PDF signature." });
    }

    const providers = selectedProvidersValidator.parse(JSON.parse(String(request.body.providers ?? '["ollama"]')));
    if (providers.includes("api") && (!config.apiKey || !config.apiModel)) {
      unlinkSync(request.file.path);
      return response.status(422).json({ error: "Configure AI_API_KEY and AI_MODEL before selecting the API comparison model." });
    }

    const ollamaModel = request.body.ollamaModel ? String(request.body.ollamaModel).trim() : undefined;

    const bytes = readFileSync(request.file.path);
    const id = randomUUID();
    database.insert({
      id,
      fileName: path.basename(request.file.originalname).slice(0, 255),
      filePath: request.file.path,
      fileSize: request.file.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      selectedProviders: providers,
    });
    setImmediate(() => void processExtraction(id, providers, ollamaModel));
    response.status(202).json(database.get(id));
  } catch (error) {
    if (request.file && existsSync(request.file.path)) unlinkSync(request.file.path);
    next(error);
  }
});

async function processExtraction(id: string, providers: ProviderKey[], ollamaModelOverride?: string): Promise<void> {
  try {
    const filePath = database.getPrivatePath(id);
    if (!filePath) throw new Error("The private PDF source could not be resolved.");

    database.update(id, { status: "running", stage: "validating", progress: 15, error: null });
    database.appendEvent(id, "validating", "PDF signature, size, and SHA-256 recorded");

    database.update(id, { stage: "extracting_text", progress: 35 });
    database.appendEvent(id, "extracting_text", "Extracting page-aware text with pdftotext");
    const text = await extractPdfText(filePath, config.pdfTextCommand, config.timeoutMs);
    database.update(id, { extractionMethod: "local_pdftotext", stage: "running_models", progress: 55 });
    database.appendEvent(id, "running_models", `Running ${providers.length} selected model${providers.length === 1 ? "" : "s"} with thinking disabled`);

    const jobs = providers.map(async (provider) => {
      const result = provider === "ollama" ? await runOllama(text, config, ollamaModelOverride) : await runApiModel(text, config);
      database.appendEvent(id, "model_complete", `${result.model} returned schema-constrained metadata`);
      return result;
    });
    const settled = await Promise.allSettled(jobs);
    const results: Record<string, unknown> = {};
    const failures: string[] = [];
    settled.forEach((outcome, index) => {
      const provider = providers[index];
      if (outcome.status === "fulfilled") results[provider] = outcome.value;
      else failures.push(`${provider}: ${outcome.reason instanceof Error ? outcome.reason.message : "Unknown provider error"}`);
    });
    if (Object.keys(results).length === 0) throw new Error(failures.join(" | "));

    database.update(id, { stage: "validating_schema", progress: 85, results });
    database.appendEvent(id, "validating_schema", "RIKMS field types, limits, and SDG ranges validated");
    database.update(id, {
      status: "completed",
      stage: "completed",
      progress: 100,
      results,
      error: failures.length ? `Partial comparison failure — ${failures.join(" | ")}` : null,
    });
    database.appendEvent(id, "completed", failures.length ? "Available result saved; one comparison provider failed" : "Results saved to SQLite history");
  } catch (error) {
    const message = error instanceof ZodError ? "The model returned metadata that failed the canonical RIKMS schema." : error instanceof Error ? error.message : "Extraction failed.";
    database.update(id, { status: "failed", stage: "failed", progress: 100, error: message });
    database.appendEvent(id, "failed", message);
  }
}

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  void _next;
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({ error: `PDF files may not exceed ${maximumUploadBytes / 1024 / 1024} MB.` });
  }
  if (error instanceof ZodError) return response.status(422).json({ error: "The submitted data is invalid.", details: error.issues });
  const message = error instanceof Error ? error.message : "Unexpected server error.";
  response.status(500).json({ error: message });
});

const server = app.listen(port, host, () => {
  console.log(`RIKMS Metadata Lab API listening on http://${host}:${port}`);
});

function shutdown(): void {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
