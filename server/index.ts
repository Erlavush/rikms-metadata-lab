import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readSync, renameSync, unlinkSync, chmodSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { ZodError, z } from "zod";
import type { ExtractionView, FieldValue, ProviderKey, Rating } from "./contracts.js";
import { loadLabConfig, type LabConfig } from "./config.js";
import { LabDatabase } from "./database.js";
import { providerReachability, resolveInstalledOllamaModel } from "./extraction.js";
import { PipelineWorker } from "./pipeline.js";
import { readRenderedPage, renderPagePng } from "./parsers/ocr.js";
import { publicErrorMessage, redactEventDetails, redactPrivatePaths } from "./public-errors.js";
import { metadataFields, parseFieldValue, reviewRequestValidator } from "./schema.js";
import { createCacheKey, createPipelineFingerprint, PIPELINE_VERSION, PROMPT_VERSION, SCHEMA_VERSION, TAXONOMY_VERSION } from "./version.js";

const selectedProvidersValidator = z.array(z.enum(["ollama", "api"])).min(1).max(2);
const ollamaModelValidator = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/);
const scoreValidator = z.object({ scores: z.record(z.string(), z.enum(["correct", "partial", "incorrect"])) });

class UnavailableOllamaModelError extends Error {}

async function hashFile(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function validPdfSignature(filePath: string): boolean {
  const descriptor = openSync(filePath, "r");
  try {
    const signature = Buffer.alloc(5);
    const read = readSync(descriptor, signature, 0, signature.length, 0);
    return read === 5 && signature.toString("ascii") === "%PDF-";
  } finally {
    closeSync(descriptor);
  }
}

function safeUnlink(filePath: string | undefined): void {
  if (!filePath || !existsSync(filePath)) return;
  unlinkSync(filePath);
}

function pathIsWithin(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function deletePrivateFile(candidate: string | null | undefined, config: LabConfig): void {
  if (!candidate || (!pathIsWithin(candidate, config.uploadDirectory) && !pathIsWithin(candidate, config.artifactDirectory))) return;
  safeUnlink(candidate);
}

function parseProviderScoreKey(key: string): { provider: ProviderKey; field: string } | null {
  const [provider, ...fieldParts] = key.split(".");
  const field = fieldParts.join(".");
  if (!["ollama", "api"].includes(provider) || !(metadataFields as readonly string[]).includes(field)) return null;
  return { provider: provider as ProviderKey, field };
}

function publicExtraction(record: ExtractionView | null): ExtractionView | null {
  if (!record) return null;
  return {
    ...record,
    error: record.error ? redactPrivatePaths(record.error) : null,
    events: record.events.map((event) => ({
      ...event,
      message: redactPrivatePaths(event.message),
      details: redactEventDetails(event.details) as Record<string, unknown>,
    })),
  };
}

export type LabRuntime = {
  app: express.Express;
  database: LabDatabase;
  worker: PipelineWorker;
  config: LabConfig;
  close(): void;
};

export function createLabRuntime(config = loadLabConfig()): LabRuntime {
  mkdirSync(config.uploadDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(config.artifactDirectory, { recursive: true, mode: 0o700 });
  const database = new LabDatabase(config.databasePath);
  const worker = new PipelineWorker(database, config);
  const storage = multer.diskStorage({
    destination: config.uploadDirectory,
    filename: (_request, _file, callback) => callback(null, `${randomUUID()}.pdf`),
  });
  const upload = multer({
    storage,
    limits: { fileSize: config.maximumUploadBytes, files: 1, fields: 8, fieldSize: 32_000 },
    fileFilter: (_request, file, callback) => {
      const extensionIsPdf = path.extname(file.originalname).toLowerCase() === ".pdf";
      const mimeIsPdf = ["application/pdf", "application/octet-stream"].includes(file.mimetype);
      if (extensionIsPdf && mimeIsPdf) callback(null, true);
      else callback(new Error("Only PDF files are accepted."));
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
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "same-site");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "OPTIONS") return response.sendStatus(204);
    next();
  });

  const currentCapabilitiesAndFingerprint = async (ollamaModel = config.ollamaModel) => {
    const capabilities = await worker.capabilities();
    return {
      capabilities,
      fingerprint: createPipelineFingerprint({
        parsers: capabilities.map(({ name, configured, reachable, version }) => ({ name, configured, reachable, version })),
        primaryModel: ollamaModel,
        verificationMode: "same-model-second-pass",
        apiModel: config.apiModel || null,
        ocrLanguages: config.ocrLanguages,
        ocrDpi: config.ocrDpi,
        doclingMode: config.doclingMode,
        grobidMode: config.grobidMode,
      }),
    };
  };

  const selectedOllamaModel = async (requested: unknown): Promise<string> => {
    const explicit = requested !== undefined && requested !== null && String(requested).trim() !== "";
    const requestedModel = ollamaModelValidator.parse(explicit ? requested : config.ollamaModel);
    const reachability = await providerReachability(config);
    const installed = resolveInstalledOllamaModel(reachability.models, requestedModel);
    if (installed) return installed;
    if (!explicit && reachability.models.length === 0) return requestedModel;
    throw new UnavailableOllamaModelError(`The selected Ollama model is not installed on this PC: ${requestedModel}`);
  };

  app.get("/api/health", async (_request, response) => {
    const reachability = await providerReachability(config);
    response.json({
      ok: true,
      database: "sqlite-wal",
      durableQueue: true,
      pipelineVersion: PIPELINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      ollamaModel: config.ollamaModel,
      ollamaReachable: reachability.ollama,
    });
  });

  app.get("/api/config", async (_request, response) => {
    const reachability = await providerReachability(config);
    const defaultModel = resolveInstalledOllamaModel(reachability.models, config.ollamaModel) ?? reachability.models[0] ?? config.ollamaModel;
    const { capabilities, fingerprint } = await currentCapabilitiesAndFingerprint(defaultModel);
    response.json({
      maxUploadMb: config.maximumUploadBytes / 1024 / 1024,
      maxPages: config.maximumPages,
      pipelineVersion: PIPELINE_VERSION,
      schemaVersion: SCHEMA_VERSION,
      parserFingerprint: fingerprint,
      providers: {
        ollama: { configured: true, reachable: reachability.models.length > 0, model: defaultModel, models: reachability.models },
        api: { configured: Boolean(config.apiKey && config.apiModel), reachable: reachability.api, model: config.apiModel || "Not configured" },
      },
      capabilities: {
        parsers: capabilities,
        durableQueue: true,
        calibratedConfidence: database.hasCalibrationProfiles(),
        evidenceCoordinates: true,
        crossrefEnabled: config.crossrefEnabled,
      },
    });
  });

  app.get("/api/extractions", (request, response) => {
    const limit = Number.parseInt(String(request.query.limit ?? "30"), 10);
    response.json({ extractions: database.listExtractions(limit).map((record) => publicExtraction(record)) });
  });

  app.get("/api/extractions/:id", (request, response) => {
    const record = database.getExtraction(request.params.id);
    if (!record) return response.status(404).json({ error: "Extraction not found." });
    response.json(publicExtraction(record));
  });

  app.get("/api/extractions/:id/attempts", (request, response) => {
    const record = database.getExtraction(request.params.id);
    if (!record) return response.status(404).json({ error: "Extraction not found." });
    const provider = request.query.provider === undefined
      ? undefined
      : z.enum(["ollama", "api"]).parse(request.query.provider);
    const field = request.query.field === undefined
      ? undefined
      : z.enum(metadataFields).parse(request.query.field);
    response.json({ attempts: database.getFieldAttempts(record.id, provider, field) });
  });

  app.get("/api/extractions/:id/pages/:page/blocks", (request, response) => {
    const record = database.getExtraction(request.params.id);
    if (!record) return response.status(404).json({ error: "Extraction not found." });
    const page = Number.parseInt(request.params.page, 10);
    if (!Number.isInteger(page) || page < 1 || (record.pageCount !== null && page > record.pageCount)) return response.status(422).json({ error: "Invalid page number." });
    response.json({ page, blocks: database.getBlocks(record.id).filter((block) => block.page === page) });
  });

  app.get("/api/extractions/:id/pages/:page/image", async (request, response, next) => {
    try {
      const record = database.getExtraction(request.params.id);
      if (!record) return response.status(404).json({ error: "Extraction not found." });
      const page = Number.parseInt(request.params.page, 10);
      if (!Number.isInteger(page) || page < 1 || (record.pageCount !== null && page > record.pageCount)) return response.status(422).json({ error: "Invalid page number." });
      const filePath = database.getPrivatePath(record.id);
      if (!filePath || !existsSync(filePath)) return response.status(404).json({ error: "Private PDF source is unavailable." });
      const imagePath = await renderPagePng(filePath, page, record.id, config, 130);
      response.type("png").send(readRenderedPage(imagePath));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/extractions", upload.single("paper"), async (request, response, next) => {
    let uploadCommitted = false;
    try {
      if (!request.file) return response.status(400).json({ error: "Choose a PDF to extract." });
      chmodSync(request.file.path, 0o600);
      if (!validPdfSignature(request.file.path)) {
        safeUnlink(request.file.path);
        return response.status(422).json({ error: "The selected file does not have a valid PDF signature." });
      }
      const providers = selectedProvidersValidator.parse(JSON.parse(String(request.body.providers ?? '["ollama"]')));
      if (providers.includes("api") && (!config.apiKey || !config.apiModel)) {
        safeUnlink(request.file.path);
        return response.status(422).json({ error: "Configure AI_API_KEY and AI_MODEL before selecting the API comparison model." });
      }
      const ollamaModel = await selectedOllamaModel(request.body.ollamaModel);
      const sha256 = await hashFile(request.file.path);
      const { fingerprint } = await currentCapabilitiesAndFingerprint(ollamaModel);
      const cacheKey = createCacheKey(sha256, fingerprint, providers);
      const forceReprocess = String(request.body.reprocess ?? "false") === "true";
      if (!forceReprocess) {
        const compatible = database.findCompatibleRun(cacheKey);
        if (compatible) {
          safeUnlink(request.file.path);
          return response.status(200).json(publicExtraction({ ...compatible, cacheHit: true, cacheSourceRunId: compatible.id }));
        }
      }
      const originalName = path.basename(request.file.originalname).slice(0, 255);
      const upserted = database.upsertDocument({
        sha256,
        fileName: originalName,
        filePath: request.file.path,
        fileSize: request.file.size,
        mimeType: "application/pdf",
      });
      if (upserted.existed) {
        if (existsSync(upserted.document.filePath)) safeUnlink(request.file.path);
        else {
          const replacementPath = path.join(config.uploadDirectory, `${upserted.document.id.replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`);
          renameSync(request.file.path, replacementPath);
          chmodSync(replacementPath, 0o600);
          database.updateDocument(upserted.document.id, { filePath: replacementPath });
        }
      }
      // From this point onward the uploaded bytes either belong to `documents`
      // or have already been discarded as a duplicate. Error cleanup must not
      // delete the persisted source PDF if run creation fails afterward.
      uploadCommitted = true;
      response.locals.uploadCommitted = true;
      const runId = database.createRun({
        documentId: upserted.document.id,
        cacheKey,
        parserFingerprint: fingerprint,
        selectedProviders: providers,
        config: {
          promptVersion: PROMPT_VERSION,
          taxonomyVersion: TAXONOMY_VERSION,
          model: ollamaModel,
          verificationMode: "same-model-second-pass",
          doclingMode: config.doclingMode,
          grobidMode: config.grobidMode,
          ocrLanguages: config.ocrLanguages,
        },
      });
      worker.wake();
      response.status(202).json(publicExtraction(database.getExtraction(runId)));
    } catch (error) {
      if (!uploadCommitted) safeUnlink(request.file?.path);
      next(error);
    }
  });

  app.post("/api/extractions/:id/reprocess", async (request, response, next) => {
    try {
      const source = database.getExtraction(request.params.id);
      if (!source) return response.status(404).json({ error: "Extraction not found." });
      const providers = selectedProvidersValidator.parse(request.body?.providers ?? source.selectedProviders);
      if (providers.includes("api") && (!config.apiKey || !config.apiModel)) {
        return response.status(422).json({ error: "Configure AI_API_KEY and AI_MODEL before selecting the API comparison model." });
      }
      const ollamaModel = await selectedOllamaModel(request.body?.ollamaModel);
      const { fingerprint } = await currentCapabilitiesAndFingerprint(ollamaModel);
      const runId = database.createRun({
        documentId: source.documentId,
        cacheKey: createCacheKey(source.sha256, fingerprint, providers),
        parserFingerprint: fingerprint,
        selectedProviders: providers,
        config: {
          reprocessedFrom: source.id,
          promptVersion: PROMPT_VERSION,
          taxonomyVersion: TAXONOMY_VERSION,
          model: ollamaModel,
          verificationMode: "same-model-second-pass",
          doclingMode: config.doclingMode,
          grobidMode: config.grobidMode,
          ocrLanguages: config.ocrLanguages,
        },
      });
      worker.wake();
      response.status(202).json(publicExtraction(database.getExtraction(runId)));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/extractions/:id/reviews", (request, response) => {
    const record = database.getExtraction(request.params.id);
    if (!record) return response.status(404).json({ error: "Extraction not found." });
    const parsed = reviewRequestValidator.parse(request.body);
    const result = record.results[parsed.provider]?.fields?.[parsed.field];
    if (!result) return response.status(422).json({ error: "That provider-field result does not exist." });
    let correctedValue: FieldValue = result.value;
    if (parsed.action === "correct") {
      if (parsed.correctedValue === undefined) return response.status(422).json({ error: "A corrected value is required." });
      correctedValue = parseFieldValue(parsed.field, parsed.correctedValue);
    } else if (parsed.action === "not_found") correctedValue = ["authors", "keywords", "recommendations", "suggested_sdgs", "evidence_pages"].includes(parsed.field) ? [] : parsed.field === "overall_confidence" ? 0 : "";
    else if (parsed.action === "not_applicable") correctedValue = null;
    const rating: Rating | null = parsed.rating ?? (parsed.action === "confirm" ? "correct" : parsed.action === "correct" ? "partial" : "incorrect");
    database.addReview(record.id, {
      provider: parsed.provider,
      field: parsed.field,
      action: parsed.action,
      rating,
      correctedValue,
      notes: parsed.notes,
      reviewer: parsed.reviewer,
    });
    response.json(publicExtraction(database.getExtraction(record.id)));
  });

  app.delete("/api/extractions/:id", (request, response) => {
    const record = database.getExtraction(request.params.id);
    if (!record) return response.status(404).json({ error: "Extraction not found." });
    z.object({ confirm: z.literal(true) }).strict().parse(request.body);
    if (["queued", "running"].includes(record.status)) {
      return response.status(409).json({ error: "An active extraction cannot be deleted. Wait for it to finish or fail first." });
    }
    const deleted = database.deleteExtraction(record.id);
    deleted.artifactPaths.forEach((artifactPath) => deletePrivateFile(artifactPath, config));
    deletePrivateFile(deleted.sourcePath, config);
    const runArtifacts = path.join(config.artifactDirectory, record.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120));
    if (pathIsWithin(runArtifacts, config.artifactDirectory) && existsSync(runArtifacts)) rmSync(runArtifacts, { recursive: true, force: true });
    response.json({ deleted: deleted.deleted, documentDeleted: deleted.documentDeleted });
  });

  app.patch("/api/extractions/:id/scores", (request, response) => {
    const record = database.getExtraction(request.params.id);
    if (!record) return response.status(404).json({ error: "Extraction not found." });
    const parsed = scoreValidator.parse(request.body);
    const ratings: Record<string, Rating> = {};
    for (const [key, rating] of Object.entries(parsed.scores)) {
      const scoreKey = parseProviderScoreKey(key);
      if (!scoreKey) continue;
      const result = record.results[scoreKey.provider]?.fields?.[scoreKey.field];
      if (!result) continue;
      ratings[key] = rating;
    }
    database.setQualityRatings(record.id, ratings);
    response.json(publicExtraction(database.getExtraction(record.id)));
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    void _next;
    if (!response.locals.uploadCommitted) safeUnlink(request.file?.path);
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      return response.status(413).json({ error: `PDF files may not exceed ${config.maximumUploadBytes / 1024 / 1024} MB.` });
    }
    if (error instanceof UnavailableOllamaModelError) return response.status(422).json({ error: error.message });
    if (error instanceof ZodError) return response.status(422).json({ error: "The submitted data is invalid.", details: error.issues });
    response.status(500).json({ error: publicErrorMessage(error) });
  });

  worker.start();
  return {
    app,
    database,
    worker,
    config,
    close() {
      worker.stop();
      database.close();
    },
  };
}

const isMainModule = process.argv[1] ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) : false;
if (isMainModule) {
  const runtime = createLabRuntime();
  const server = runtime.app.listen(runtime.config.port, runtime.config.host, () => {
    console.log(`RIKMS Metadata Lab API listening on http://${runtime.config.host}:${runtime.config.port}`);
  });
  const shutdown = () => {
    runtime.worker.stop();
    server.close(() => {
      runtime.database.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
