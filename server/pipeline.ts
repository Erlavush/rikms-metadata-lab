import { randomUUID } from "node:crypto";
import type { LabConfig } from "./config.js";
import type { LabDatabase } from "./database.js";
import { buildHybridDocument, inspectParserCapabilities } from "./document.js";
import { classifyDocumentWithModel, releaseLocalModelMemory } from "./extraction.js";
import { processAllFields } from "./fields.js";
import { redactPrivatePaths } from "./public-errors.js";

export function modelForRun(defaultModel: string, runOptions: Record<string, unknown>): string {
  const requestedModel = typeof runOptions.model === "string" ? runOptions.model.trim() : "";
  return requestedModel && requestedModel.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(requestedModel)
    ? requestedModel
    : defaultModel;
}

export class PipelineWorker {
  private readonly workerId = `local-worker-${randomUUID()}`;
  private stopped = true;
  private processing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: LabDatabase,
    private readonly config: LabConfig,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const recovered = this.database.recoverExpiredRuns();
    if (recovered > 0) console.log(`Recovered ${recovered} interrupted extraction run${recovered === 1 ? "" : "s"}.`);
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  wake(): void {
    if (this.stopped || this.processing) return;
    if (this.timer) clearTimeout(this.timer);
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.processing) return;
    const job = this.database.claimNextRun(this.workerId, this.config.leaseMs);
    if (!job) {
      this.schedule(700);
      return;
    }
    this.processing = true;
    try {
      await this.process(job.id, job.document.id, job.document.filePath, job.providers, job.config);
    } finally {
      this.processing = false;
      this.schedule(50);
    }
  }

  private async process(
    runId: string,
    documentId: string,
    filePath: string,
    providers: Array<"ollama" | "api">,
    runOptions: Record<string, unknown>,
  ): Promise<void> {
    const heartbeat = setInterval(() => this.database.renewLease(runId, this.workerId, this.config.leaseMs), Math.max(5_000, Math.floor(this.config.leaseMs / 3)));
    heartbeat.unref();
    try {
      const selectedModel = modelForRun(this.config.ollamaModel, runOptions);
      const runConfig: LabConfig = { ...this.config, ollamaModel: selectedModel };
      this.database.updateRun(runId, { status: "running", stage: "validating", progress: 8, error: null });
      this.database.appendEvent(runId, "validating", "Validating PDF structure, encryption, page limits, and parser safety boundaries");
      const releasedModels = await releaseLocalModelMemory(runConfig);
      this.database.appendEvent(runId, "resource_scheduling", "Prepared local accelerator memory before document-layout processing", { releasedModels });
      this.database.updateRun(runId, { stage: "primary_parsing", progress: 18 });
      const document = await buildHybridDocument(filePath, runId, runConfig, (stage, message, details = {}) => {
        this.database.appendEvent(runId, stage, message, details);
        if (stage === "quality_assessment" && typeof details.pageCount === "number") {
          this.database.updateDocument(documentId, { pageCount: details.pageCount });
        }
        const progressByStage: Record<string, number> = {
          primary_parsing: 20,
          quality_assessment: 32,
          layout_enrichment: 39,
          selective_ocr: 44,
          scholarly_parsing: 49,
          parser_fallback: 39,
        };
        if (stage in progressByStage) this.database.updateRun(runId, { stage, progress: progressByStage[stage] });
      });
      this.database.updateDocument(documentId, {
        pageCount: document.inventory.pages,
        documentType: document.documentType,
        language: document.language,
      });
      this.database.updateRun(runId, {
        stage: "normalizing_document",
        progress: 52,
        extractionMethod: document.methods.join("+"),
      });
      this.database.replaceStructure(runId, document.pages, document.blocks);
      document.artifactPaths.forEach((artifact) => this.database.addArtifact(runId, artifact.type, artifact.version, { filePath: artifact.path }));
      this.database.appendEvent(runId, "normalizing_document", "Canonical document IR saved with reading order, page coordinates, source engines, and quality signals", {
        pages: document.pages.length,
        blocks: document.blocks.length,
        methods: document.methods,
      });
      let documentType = document.documentType;
      let language = document.language;
      if (documentType === "unknown") {
        this.database.updateRun(runId, { stage: "classifying_document", progress: 57 });
        const classification = await classifyDocumentWithModel(document.blocks, runConfig);
        if (classification) {
          documentType = classification.documentType;
          language = classification.language;
          this.database.updateDocument(documentId, { documentType, language });
          this.database.appendEvent(runId, "classifying_document", "Dedicated local classifier resolved document type and language", { documentType, language });
        } else {
          this.database.appendEvent(runId, "classifying_document", "Document type remained unknown and will be reviewed explicitly");
        }
      }
      this.database.updateRun(runId, { stage: "field_extraction", progress: 60 });
      this.database.appendEvent(runId, "field_extraction", "Started field-oriented extraction with deterministic, grounded-summary, and classification strategies", {
        providers,
        model: selectedModel,
        verificationMode: "same-model-second-pass",
      });
      await processAllFields({
        providers,
        documentType,
        pages: document.pages,
        blocks: document.blocks,
        grobid: document.grobid,
        config: runConfig,
        calibrate: (provider, field, rawScore) => this.database.calibrate(provider, field, rawScore),
        onAttempt: (attempt) => this.database.saveFieldAttempt(runId, attempt),
        onResult: (result) => {
          this.database.saveFieldResult(runId, result);
          this.database.appendEvent(runId, "field_result", `${result.field} resolved as ${result.status}`, {
            provider: result.provider,
            method: result.method,
            attempts: result.attempts,
            acceptanceScore: result.acceptanceScore,
            evidenceCount: result.evidence.length,
          });
        },
        onProgress: (completed, total, field, provider) => {
          const progress = 60 + Math.round((completed / Math.max(1, total)) * 34);
          this.database.updateRun(runId, { stage: "field_extraction", progress });
          if (completed === total || completed % 4 === 0) {
            this.database.appendEvent(runId, "field_progress", `${completed} of ${total} field-provider tasks processed`, { field, provider });
          }
        },
      });
      this.database.updateRun(runId, {
        status: "awaiting_review",
        stage: "awaiting_review",
        progress: 100,
        workerId: null,
        leaseExpiresAt: null,
        error: null,
      });
      this.database.appendEvent(runId, "awaiting_review", "Machine extraction finished; field-level human confirmation is required before completion");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Extraction failed.";
      this.database.updateRun(runId, {
        status: "failed",
        stage: "failed",
        workerId: null,
        leaseExpiresAt: null,
        error: redactPrivatePaths(message),
      });
      this.database.appendEvent(runId, "failed", redactPrivatePaths(message));
    } finally {
      clearInterval(heartbeat);
    }
  }

  async capabilities(): Promise<Awaited<ReturnType<typeof inspectParserCapabilities>>> {
    return await inspectParserCapabilities(this.config);
  }
}
