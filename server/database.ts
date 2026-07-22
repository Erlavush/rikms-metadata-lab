import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AuditEvent,
  DocumentBlock,
  DocumentPage,
  DocumentRecord,
  ExtractionView,
  FieldAttempt,
  FieldResult,
  FieldValue,
  ProviderKey,
  ProviderResult,
  Rating,
  ReviewAction,
  ReviewRecord,
  RunStatus,
} from "./contracts.js";
import { applyCalibration, trainCalibrationProfile, type CalibrationProfile } from "./calibration.js";
import { PIPELINE_VERSION, SCHEMA_VERSION } from "./version.js";

type JsonObject = Record<string, unknown>;

type RunRow = {
  id: string;
  document_id: string;
  cache_key: string;
  pipeline_version: string;
  schema_version: string;
  parser_fingerprint: string;
  selected_providers_json: string;
  status: RunStatus;
  stage: string;
  progress: number;
  extraction_method: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  run_attempts: number;
  error: string | null;
  cache_hit: number;
  cache_source_run_id: string | null;
  config_json: string;
  legacy_results_json: string;
  legacy_scores_json: string;
  created_at: string;
  updated_at: string;
  file_name: string;
  file_path: string;
  file_size: number;
  sha256: string;
  mime_type: string;
  page_count: number | null;
  document_type: string | null;
  language: string | null;
};

type FieldRow = {
  provider: ProviderKey;
  field_key: string;
  result_json: string;
};

type ReviewRow = {
  id: string;
  provider: ProviderKey;
  field_key: string;
  action: ReviewAction;
  rating: Rating | null;
  corrected_value_json: string;
  notes: string;
  reviewer: string;
  created_at: string;
};

type PageRow = {
  page_number: number;
  width: number;
  height: number;
  native_characters: number;
  native_words: number;
  replacement_ratio: number;
  parse_score: number;
  grade: DocumentPage["grade"];
  reasons_json: string;
  ocr_applied: number;
  source_engine: string;
  text: string;
};

type BlockRow = {
  block_id: string;
  page_number: number;
  block_type: DocumentBlock["type"];
  text: string;
  normalized_text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  reading_order: number;
  section_path_json: string;
  source_engine: string;
  source_confidence: number | null;
  source_ids_json: string;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isoAfter(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

function emptyValue(field: string): FieldValue {
  if (["authors", "keywords", "recommendations", "suggested_sdgs", "evidence_pages"].includes(field)) return [];
  if (field === "overall_confidence") return 0;
  return "";
}

export class LabDatabase {
  readonly connection: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(databasePath);
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    this.createSchema();
    this.migrateLegacyExtractions();
  }

  private createSchema(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        page_count INTEGER,
        document_type TEXT,
        language TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        cache_key TEXT NOT NULL,
        pipeline_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        parser_fingerprint TEXT NOT NULL,
        selected_providers_json TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL,
        extraction_method TEXT,
        worker_id TEXT,
        lease_expires_at TEXT,
        run_attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        cache_source_run_id TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        legacy_results_json TEXT NOT NULL DEFAULT '{}',
        legacy_scores_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS document_pages (
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        page_number INTEGER NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        native_characters INTEGER NOT NULL,
        native_words INTEGER NOT NULL,
        replacement_ratio REAL NOT NULL,
        parse_score REAL NOT NULL,
        grade TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        ocr_applied INTEGER NOT NULL,
        source_engine TEXT NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (run_id, page_number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS document_blocks (
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        block_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        block_type TEXT NOT NULL,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        reading_order INTEGER NOT NULL,
        section_path_json TEXT NOT NULL,
        source_engine TEXT NOT NULL,
        source_confidence REAL,
        source_ids_json TEXT NOT NULL,
        PRIMARY KEY (run_id, block_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS field_results (
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        field_key TEXT NOT NULL,
        result_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, provider, field_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS field_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        field_key TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        candidate_block_ids_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, provider, field_key, attempt_number)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS evidence_spans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        field_key TEXT NOT NULL,
        block_id TEXT NOT NULL,
        page_number INTEGER NOT NULL,
        quote TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        width REAL NOT NULL,
        height REAL NOT NULL,
        source_engine TEXT NOT NULL,
        exact_match INTEGER NOT NULL,
        semantic_support TEXT NOT NULL,
        support_score REAL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        field_key TEXT NOT NULL,
        action TEXT NOT NULL,
        rating TEXT,
        corrected_value_json TEXT NOT NULL,
        notes TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (run_id, sequence)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
        artifact_type TEXT NOT NULL,
        version TEXT NOT NULL,
        file_path TEXT,
        content_json TEXT NOT NULL DEFAULT '{}',
        sha256 TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS calibration_profiles (
        pipeline_version TEXT NOT NULL,
        provider TEXT NOT NULL,
        field_key TEXT NOT NULL,
        sample_count INTEGER NOT NULL,
        profile_json TEXT NOT NULL,
        brier_before REAL NOT NULL,
        brier_after REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (pipeline_version, provider, field_key)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS deletion_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        document_sha256 TEXT NOT NULL,
        reason TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS pipeline_runs_created_idx ON pipeline_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS pipeline_runs_cache_idx ON pipeline_runs(cache_key, status);
      CREATE INDEX IF NOT EXISTS pipeline_runs_queue_idx ON pipeline_runs(status, created_at);
      CREATE INDEX IF NOT EXISTS document_blocks_page_idx ON document_blocks(run_id, page_number, reading_order);
      CREATE INDEX IF NOT EXISTS evidence_spans_field_idx ON evidence_spans(run_id, provider, field_key);
      CREATE INDEX IF NOT EXISTS field_attempts_field_idx ON field_attempts(run_id, provider, field_key, attempt_number);
      CREATE INDEX IF NOT EXISTS reviews_field_idx ON reviews(run_id, provider, field_key, created_at DESC);
    `);
  }

  private tableExists(name: string): boolean {
    const row = this.connection
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { present: number } | undefined;
    return Boolean(row);
  }

  private migrateLegacyExtractions(): void {
    if (!this.tableExists("extractions")) return;
    const rows = this.connection.prepare("SELECT * FROM extractions ORDER BY created_at ASC").all() as unknown as Array<Record<string, unknown>>;
    const insertRun = this.connection.prepare(`
      INSERT OR IGNORE INTO pipeline_runs (
        id, document_id, cache_key, pipeline_version, schema_version, parser_fingerprint,
        selected_providers_json, status, stage, progress, extraction_method, error,
        legacy_results_json, legacy_scores_json, created_at, updated_at
      ) VALUES (?, ?, ?, '1.0.0', '1.0.0', 'legacy-v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const id = String(row.id);
      const existing = this.connection.prepare("SELECT 1 AS present FROM pipeline_runs WHERE id = ?").get(id);
      if (existing) continue;
      const sha256 = String(row.sha256);
      let document = this.connection.prepare("SELECT id FROM documents WHERE sha256 = ?").get(sha256) as { id: string } | undefined;
      if (!document) {
        const documentId = `legacy-${id}`;
        this.connection.prepare(`
          INSERT INTO documents (id, sha256, file_name, file_path, file_size, mime_type, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, ?)
        `).run(documentId, sha256, String(row.file_name), String(row.file_path), Number(row.file_size), String(row.created_at), String(row.updated_at));
        document = { id: documentId };
      }
      insertRun.run(
        id,
        document.id,
        `legacy-${id}`,
        String(row.selected_providers_json),
        String(row.status),
        String(row.stage),
        Number(row.progress),
        row.extraction_method === null ? null : String(row.extraction_method),
        row.error === null ? null : String(row.error),
        String(row.results_json),
        String(row.scores_json),
        String(row.created_at),
        String(row.updated_at),
      );
      const events = parseJson<Array<{ stage: string; message: string; at: string }>>(String(row.events_json), []);
      events.forEach((event, index) => {
        this.connection.prepare(`
          INSERT OR IGNORE INTO audit_events (run_id, sequence, stage, message, details_json, created_at)
          VALUES (?, ?, ?, ?, '{}', ?)
        `).run(id, index + 1, event.stage, event.message, event.at);
      });
    }
  }

  upsertDocument(input: {
    id?: string;
    sha256: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    mimeType: string;
  }): { document: DocumentRecord; existed: boolean } {
    const existing = this.getDocumentByHash(input.sha256);
    if (existing) return { document: existing, existed: true };
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.connection.prepare(`
      INSERT INTO documents (id, sha256, file_name, file_path, file_size, mime_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sha256, input.fileName, input.filePath, input.fileSize, input.mimeType, now, now);
    return { document: this.getDocument(id)!, existed: false };
  }

  updateDocument(id: string, patch: Partial<Pick<DocumentRecord, "pageCount" | "documentType" | "language" | "filePath">>): void {
    const mapping: Record<string, string> = {
      pageCount: "page_count",
      documentType: "document_type",
      language: "language",
      filePath: "file_path",
    };
    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in mapping)) continue;
      columns.push(`${mapping[key]} = ?`);
      values.push(value);
    }
    if (!columns.length) return;
    columns.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    this.connection.prepare(`UPDATE documents SET ${columns.join(", ")} WHERE id = ?`).run(...values);
  }

  getDocument(id: string): DocumentRecord | null {
    const row = this.connection.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapDocument(row) : null;
  }

  getDocumentByHash(sha256: string): DocumentRecord | null {
    const row = this.connection.prepare("SELECT * FROM documents WHERE sha256 = ?").get(sha256) as Record<string, unknown> | undefined;
    return row ? this.mapDocument(row) : null;
  }

  private mapDocument(row: Record<string, unknown>): DocumentRecord {
    return {
      id: String(row.id),
      sha256: String(row.sha256),
      fileName: String(row.file_name),
      filePath: String(row.file_path),
      fileSize: Number(row.file_size),
      mimeType: String(row.mime_type),
      pageCount: row.page_count === null ? null : Number(row.page_count),
      documentType: row.document_type === null ? null : String(row.document_type),
      language: row.language === null ? null : String(row.language),
      createdAt: String(row.created_at),
    };
  }

  createRun(input: {
    id?: string;
    documentId: string;
    cacheKey: string;
    parserFingerprint: string;
    selectedProviders: ProviderKey[];
    config: JsonObject;
    cacheSourceRunId?: string | null;
  }): string {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.connection.prepare(`
      INSERT INTO pipeline_runs (
        id, document_id, cache_key, pipeline_version, schema_version, parser_fingerprint,
        selected_providers_json, status, stage, progress, cache_hit, cache_source_run_id,
        config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', 3, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.documentId,
      input.cacheKey,
      PIPELINE_VERSION,
      SCHEMA_VERSION,
      input.parserFingerprint,
      JSON.stringify(input.selectedProviders),
      input.cacheSourceRunId ? 1 : 0,
      input.cacheSourceRunId ?? null,
      JSON.stringify(input.config),
      now,
      now,
    );
    this.appendEvent(id, "queued", "Durable extraction run queued", { pipelineVersion: PIPELINE_VERSION });
    return id;
  }

  findCompatibleRun(cacheKey: string): ExtractionView | null {
    const row = this.connection.prepare(`
      SELECT id FROM pipeline_runs
      WHERE cache_key = ? AND status IN ('awaiting_review', 'completed')
      ORDER BY updated_at DESC LIMIT 1
    `).get(cacheKey) as { id: string } | undefined;
    return row ? this.getExtraction(row.id) : null;
  }

  updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus;
      stage: string;
      progress: number;
      extractionMethod: string;
      error: string | null;
      workerId: string | null;
      leaseExpiresAt: string | null;
    }>,
  ): void {
    const mapping: Record<string, string> = {
      status: "status",
      stage: "stage",
      progress: "progress",
      extractionMethod: "extraction_method",
      error: "error",
      workerId: "worker_id",
      leaseExpiresAt: "lease_expires_at",
    };
    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in mapping)) continue;
      columns.push(`${mapping[key]} = ?`);
      values.push(value);
    }
    if (!columns.length) return;
    columns.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    this.connection.prepare(`UPDATE pipeline_runs SET ${columns.join(", ")} WHERE id = ?`).run(...values);
  }

  claimNextRun(workerId: string, leaseMs: number): { id: string; document: DocumentRecord; providers: ProviderKey[]; config: JsonObject } | null {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      this.connection.prepare(`
        UPDATE pipeline_runs SET status = 'queued', stage = 'recovered', worker_id = NULL,
          lease_expires_at = NULL, error = NULL, updated_at = ?
        WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)
      `).run(now, now);
      const row = this.connection.prepare(`
        SELECT id, document_id, selected_providers_json, config_json
        FROM pipeline_runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
      `).get() as { id: string; document_id: string; selected_providers_json: string; config_json: string } | undefined;
      if (!row) {
        this.connection.exec("COMMIT");
        return null;
      }
      const result = this.connection.prepare(`
        UPDATE pipeline_runs SET status = 'running', stage = 'claimed', worker_id = ?,
          lease_expires_at = ?, run_attempts = run_attempts + 1, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(workerId, isoAfter(leaseMs), now, row.id);
      if (Number(result.changes) !== 1) {
        this.connection.exec("ROLLBACK");
        return null;
      }
      this.connection.exec("COMMIT");
      return {
        id: row.id,
        document: this.getDocument(row.document_id)!,
        providers: parseJson<ProviderKey[]>(row.selected_providers_json, ["ollama"]),
        config: parseJson<JsonObject>(row.config_json, {}),
      };
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  renewLease(id: string, workerId: string, leaseMs: number): boolean {
    const result = this.connection.prepare(`
      UPDATE pipeline_runs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND worker_id = ? AND status = 'running'
    `).run(isoAfter(leaseMs), new Date().toISOString(), id, workerId);
    return Number(result.changes) === 1;
  }

  recoverExpiredRuns(): number {
    const now = new Date().toISOString();
    const result = this.connection.prepare(`
      UPDATE pipeline_runs SET status = 'queued', stage = 'recovered', worker_id = NULL,
        lease_expires_at = NULL, error = NULL, updated_at = ?
      WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)
    `).run(now, now);
    return Number(result.changes);
  }

  appendEvent(runId: string, stage: string, message: string, details: JsonObject = {}): void {
    const row = this.connection.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM audit_events WHERE run_id = ?").get(runId) as { next: number };
    this.connection.prepare(`
      INSERT INTO audit_events (run_id, sequence, stage, message, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, row.next, stage, message, JSON.stringify(details), new Date().toISOString());
  }

  replaceStructure(runId: string, pages: DocumentPage[], blocks: DocumentBlock[]): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.prepare("DELETE FROM document_pages WHERE run_id = ?").run(runId);
      this.connection.prepare("DELETE FROM document_blocks WHERE run_id = ?").run(runId);
      const insertPage = this.connection.prepare(`
        INSERT INTO document_pages (
          run_id, page_number, width, height, native_characters, native_words,
          replacement_ratio, parse_score, grade, reasons_json, ocr_applied, source_engine, text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      pages.forEach((page) => insertPage.run(
        runId,
        page.page,
        page.width,
        page.height,
        page.nativeCharacters,
        page.nativeWords,
        page.replacementRatio,
        page.parseScore,
        page.grade,
        JSON.stringify(page.reasons),
        page.ocrApplied ? 1 : 0,
        page.sourceEngine,
        page.text,
      ));
      const insertBlock = this.connection.prepare(`
        INSERT INTO document_blocks (
          run_id, block_id, page_number, block_type, text, normalized_text,
          x, y, width, height, reading_order, section_path_json, source_engine,
          source_confidence, source_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      blocks.forEach((block) => insertBlock.run(
        runId,
        block.id,
        block.page,
        block.type,
        block.text,
        block.normalizedText,
        block.x,
        block.y,
        block.width,
        block.height,
        block.readingOrder,
        JSON.stringify(block.sectionPath),
        block.sourceEngine,
        block.sourceConfidence,
        JSON.stringify(block.sourceIds),
      ));
      this.connection.exec("COMMIT");
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  getPages(runId: string, includeText = false): DocumentPage[] {
    const rows = this.connection.prepare("SELECT * FROM document_pages WHERE run_id = ? ORDER BY page_number").all(runId) as unknown as PageRow[];
    return rows.map((row) => ({
      page: row.page_number,
      width: row.width,
      height: row.height,
      nativeCharacters: row.native_characters,
      nativeWords: row.native_words,
      replacementRatio: row.replacement_ratio,
      parseScore: row.parse_score,
      grade: row.grade,
      reasons: parseJson(row.reasons_json, []),
      ocrApplied: Boolean(row.ocr_applied),
      sourceEngine: row.source_engine,
      text: includeText ? row.text : "",
    }));
  }

  getBlocks(runId: string): DocumentBlock[] {
    const rows = this.connection.prepare(`
      SELECT * FROM document_blocks WHERE run_id = ? ORDER BY page_number, reading_order
    `).all(runId) as unknown as BlockRow[];
    return rows.map((row) => ({
      id: row.block_id,
      page: row.page_number,
      type: row.block_type,
      text: row.text,
      normalizedText: row.normalized_text,
      x: row.x,
      y: row.y,
      width: row.width,
      height: row.height,
      readingOrder: row.reading_order,
      sectionPath: parseJson(row.section_path_json, []),
      sourceEngine: row.source_engine,
      sourceConfidence: row.source_confidence,
      sourceIds: parseJson(row.source_ids_json, []),
    }));
  }

  saveFieldResult(runId: string, result: FieldResult): void {
    const now = new Date().toISOString();
    this.connection.prepare(`
      INSERT INTO field_results (run_id, provider, field_key, result_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, field_key) DO UPDATE SET
        result_json = excluded.result_json, updated_at = excluded.updated_at
    `).run(runId, result.provider, result.field, JSON.stringify(result), now);
    this.connection.prepare("DELETE FROM evidence_spans WHERE run_id = ? AND provider = ? AND field_key = ?")
      .run(runId, result.provider, result.field);
    const insertEvidence = this.connection.prepare(`
      INSERT INTO evidence_spans (
        id, run_id, provider, field_key, block_id, page_number, quote,
        x, y, width, height, source_engine, exact_match, semantic_support, support_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    result.evidence.forEach((evidence) => insertEvidence.run(
      evidence.id ?? randomUUID(),
      runId,
      result.provider,
      result.field,
      evidence.blockId,
      evidence.page,
      evidence.quote,
      evidence.x,
      evidence.y,
      evidence.width,
      evidence.height,
      evidence.sourceEngine,
      evidence.exactMatch ? 1 : 0,
      evidence.semanticSupport,
      evidence.supportScore,
    ));
  }

  getFieldResults(runId: string): FieldResult[] {
    const rows = this.connection.prepare("SELECT provider, field_key, result_json FROM field_results WHERE run_id = ? ORDER BY provider, field_key").all(runId) as unknown as FieldRow[];
    return rows.flatMap((row) => {
      const result = parseJson<FieldResult | null>(row.result_json, null);
      return result ? [result] : [];
    });
  }

  saveFieldAttempt(runId: string, attempt: FieldAttempt): void {
    const id = attempt.id ?? randomUUID();
    const createdAt = attempt.createdAt ?? new Date().toISOString();
    this.connection.prepare(`
      INSERT INTO field_attempts (
        id, run_id, provider, field_key, attempt_number, outcome,
        candidate_block_ids_json, result_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, provider, field_key, attempt_number) DO UPDATE SET
        outcome = excluded.outcome,
        candidate_block_ids_json = excluded.candidate_block_ids_json,
        result_json = excluded.result_json,
        created_at = excluded.created_at
    `).run(
      id,
      runId,
      attempt.provider,
      attempt.field,
      attempt.attempt,
      attempt.outcome,
      JSON.stringify(attempt.candidateBlockIds),
      JSON.stringify(attempt.result),
      createdAt,
    );
  }

  getFieldAttempts(runId: string, provider?: ProviderKey, field?: string): FieldAttempt[] {
    const clauses = ["run_id = ?"];
    const values: string[] = [runId];
    if (provider) {
      clauses.push("provider = ?");
      values.push(provider);
    }
    if (field) {
      clauses.push("field_key = ?");
      values.push(field);
    }
    const rows = this.connection.prepare(`
      SELECT id, provider, field_key, attempt_number, outcome,
        candidate_block_ids_json, result_json, created_at
      FROM field_attempts WHERE ${clauses.join(" AND ")}
      ORDER BY provider, field_key, attempt_number
    `).all(...values) as unknown as Array<{
      id: string;
      provider: ProviderKey;
      field_key: string;
      attempt_number: number;
      outcome: FieldAttempt["outcome"];
      candidate_block_ids_json: string;
      result_json: string;
      created_at: string;
    }>;
    return rows.flatMap((row) => {
      const result = parseJson<FieldResult | null>(row.result_json, null);
      return result ? [{
        id: row.id,
        provider: row.provider,
        field: row.field_key,
        attempt: row.attempt_number,
        outcome: row.outcome,
        candidateBlockIds: parseJson<string[]>(row.candidate_block_ids_json, []),
        result,
        createdAt: row.created_at,
      }] : [];
    });
  }

  addArtifact(runId: string, artifactType: string, version: string, input: { filePath?: string | null; content?: JsonObject; sha256?: string | null }): string {
    const id = randomUUID();
    this.connection.prepare(`
      INSERT INTO artifacts (id, run_id, artifact_type, version, file_path, content_json, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, runId, artifactType, version, input.filePath ?? null, JSON.stringify(input.content ?? {}), input.sha256 ?? null, new Date().toISOString());
    return id;
  }

  setQualityRatings(runId: string, ratings: Record<string, Rating>): boolean {
    const row = this.connection.prepare("SELECT legacy_scores_json FROM pipeline_runs WHERE id = ?").get(runId) as { legacy_scores_json: string } | undefined;
    if (!row) return false;
    if (Object.keys(ratings).length === 0) return true;
    const nextRatings = { ...parseJson<Record<string, Rating>>(row.legacy_scores_json, {}), ...ratings };
    const updatedAt = new Date().toISOString();
    this.connection.prepare(`
      UPDATE pipeline_runs SET legacy_scores_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(nextRatings), updatedAt, runId);
    this.appendEvent(runId, "quality_rating", "Human quality rating updated.", { fields: Object.keys(ratings).sort() });
    return true;
  }

  addReview(runId: string, input: {
    provider: ProviderKey;
    field: string;
    action: ReviewAction;
    rating: Rating | null;
    correctedValue: FieldValue;
    notes: string;
    reviewer: string;
  }): ReviewRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.connection.prepare(`
      INSERT INTO reviews (
        id, run_id, provider, field_key, action, rating, corrected_value_json, notes, reviewer, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, runId, input.provider, input.field, input.action, input.rating, JSON.stringify(input.correctedValue), input.notes, input.reviewer, createdAt);
    this.appendEvent(runId, "human_review", `${input.field} ${input.action.replace("_", " ")} by ${input.reviewer}`, {
      provider: input.provider,
      field: input.field,
      action: input.action,
    });
    this.refreshCalibrationProfile(input.provider, input.field);
    this.refreshReviewStatus(runId);
    return { id, ...input, createdAt };
  }

  private refreshCalibrationProfile(provider: ProviderKey, field: string): void {
    const rows = this.connection.prepare(`
      WITH ranked_reviews AS (
        SELECT reviews.run_id, reviews.provider, reviews.field_key, reviews.rating, reviews.action,
          ROW_NUMBER() OVER (
            PARTITION BY reviews.run_id, reviews.provider, reviews.field_key
            ORDER BY reviews.created_at DESC, reviews.id DESC
          ) AS rank
        FROM reviews
        JOIN pipeline_runs ON pipeline_runs.id = reviews.run_id
        WHERE reviews.provider = ? AND reviews.field_key = ?
          AND pipeline_runs.pipeline_version = ?
      )
      SELECT ranked_reviews.rating, ranked_reviews.action, field_results.result_json
      FROM ranked_reviews
      JOIN field_results ON field_results.run_id = ranked_reviews.run_id
        AND field_results.provider = ranked_reviews.provider
        AND field_results.field_key = ranked_reviews.field_key
      WHERE ranked_reviews.rank = 1
    `).all(provider, field, PIPELINE_VERSION) as unknown as Array<{
      rating: Rating | null;
      action: ReviewAction;
      result_json: string;
    }>;
    const points = rows.flatMap((row) => {
      if (row.action === "not_applicable") return [];
      const result = parseJson<FieldResult | null>(row.result_json, null);
      if (!result || !Number.isFinite(result.rawAcceptanceScore ?? result.acceptanceScore)) return [];
      const outcome = row.rating === "correct" || (!row.rating && row.action === "confirm")
        ? 1
        : row.rating === "partial"
          ? 0.5
          : 0;
      return [{ score: result.rawAcceptanceScore ?? result.acceptanceScore, outcome }];
    });
    const profile = trainCalibrationProfile(points);
    if (!profile) {
      this.connection.prepare(`
        DELETE FROM calibration_profiles
        WHERE pipeline_version = ? AND provider = ? AND field_key = ?
      `).run(PIPELINE_VERSION, provider, field);
      return;
    }
    this.connection.prepare(`
      INSERT INTO calibration_profiles (
        pipeline_version, provider, field_key, sample_count, profile_json,
        brier_before, brier_after, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pipeline_version, provider, field_key) DO UPDATE SET
        sample_count = excluded.sample_count,
        profile_json = excluded.profile_json,
        brier_before = excluded.brier_before,
        brier_after = excluded.brier_after,
        updated_at = excluded.updated_at
    `).run(
      PIPELINE_VERSION,
      provider,
      field,
      profile.sampleCount,
      JSON.stringify(profile),
      profile.brierBefore,
      profile.brierAfter,
      new Date().toISOString(),
    );
  }

  calibrate(provider: ProviderKey, field: string, rawScore: number): { score: number; calibrated: boolean; sampleCount: number } {
    const row = this.connection.prepare(`
      SELECT sample_count, profile_json FROM calibration_profiles
      WHERE pipeline_version = ? AND provider = ? AND field_key = ?
    `).get(PIPELINE_VERSION, provider, field) as { sample_count: number; profile_json: string } | undefined;
    if (!row) return { score: rawScore, calibrated: false, sampleCount: 0 };
    const profile = parseJson<CalibrationProfile | null>(row.profile_json, null);
    return profile
      ? { score: applyCalibration(profile, rawScore), calibrated: true, sampleCount: row.sample_count }
      : { score: rawScore, calibrated: false, sampleCount: 0 };
  }

  hasCalibrationProfiles(): boolean {
    const row = this.connection.prepare(`
      SELECT 1 AS present FROM calibration_profiles WHERE pipeline_version = ? LIMIT 1
    `).get(PIPELINE_VERSION) as { present: number } | undefined;
    return Boolean(row);
  }

  private refreshReviewStatus(runId: string): void {
    const fieldCount = this.connection.prepare("SELECT COUNT(*) AS count FROM field_results WHERE run_id = ?").get(runId) as { count: number };
    const reviewedCount = this.connection.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT provider, field_key FROM reviews WHERE run_id = ? GROUP BY provider, field_key
      )
    `).get(runId) as { count: number };
    const run = this.connection.prepare("SELECT status FROM pipeline_runs WHERE id = ?").get(runId) as { status: RunStatus } | undefined;
    if (run?.status !== "completed" && fieldCount.count > 0 && reviewedCount.count >= fieldCount.count) {
      this.updateRun(runId, { status: "completed", stage: "completed", progress: 100 });
      this.appendEvent(runId, "completed", "All generated fields received human review");
    }
  }

  getReviews(runId: string): ReviewRecord[] {
    const rows = this.connection.prepare("SELECT * FROM reviews WHERE run_id = ? ORDER BY created_at ASC").all(runId) as unknown as ReviewRow[];
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      field: row.field_key,
      action: row.action,
      rating: row.rating,
      correctedValue: parseJson<FieldValue>(row.corrected_value_json, null),
      notes: row.notes,
      reviewer: row.reviewer,
      createdAt: row.created_at,
    }));
  }

  private getEvents(runId: string): AuditEvent[] {
    const rows = this.connection.prepare("SELECT sequence, stage, message, details_json, created_at FROM audit_events WHERE run_id = ? ORDER BY sequence").all(runId) as unknown as Array<{
      sequence: number;
      stage: string;
      message: string;
      details_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      stage: row.stage,
      message: row.message,
      details: parseJson(row.details_json, {}),
      at: row.created_at,
    }));
  }

  getExtraction(id: string): ExtractionView | null {
    const row = this.connection.prepare(`
      SELECT r.*, d.file_name, d.file_path, d.file_size, d.sha256, d.mime_type,
        d.page_count, d.document_type, d.language
      FROM pipeline_runs r JOIN documents d ON d.id = r.document_id WHERE r.id = ?
    `).get(id) as RunRow | undefined;
    if (!row) return null;
    const fieldResults = this.getFieldResults(id);
    const reviews = this.getReviews(id);
    const latestReview = new Map<string, ReviewRecord>();
    reviews.forEach((review) => latestReview.set(`${review.provider}.${review.field}`, review));
    const results = parseJson<Partial<Record<ProviderKey, ProviderResult>>>(row.legacy_results_json, {});
    const grouped = new Map<ProviderKey, FieldResult[]>();
    fieldResults.forEach((result) => grouped.set(result.provider, [...(grouped.get(result.provider) ?? []), result]));
    for (const [provider, fields] of grouped) {
      const metadata: Record<string, unknown> = {};
      const byKey: Record<string, FieldResult> = {};
      fields.forEach((field) => {
        byKey[field.field] = field;
        const review = latestReview.get(`${provider}.${field.field}`);
        metadata[field.field] = review?.action === "correct"
          ? review.correctedValue
          : review?.action === "not_found" || review?.action === "not_applicable"
            ? emptyValue(field.field)
            : field.value;
      });
      results[provider] = {
        provider,
        model: fields.find((field) => field.model)?.model ?? "deterministic",
        metadata,
        fields: byKey,
        inputTokens: fields.reduce((sum, field) => sum + field.inputTokens, 0),
        outputTokens: fields.reduce((sum, field) => sum + field.outputTokens, 0),
        durationMs: fields.reduce((sum, field) => sum + field.durationMs, 0),
        estimatedCostUsd: provider === "ollama" ? 0 : null,
      };
    }
    const scores: Record<string, Rating> = {};
    reviews.forEach((review) => {
      if (review.rating) scores[`${review.provider}.${review.field}`] = review.rating;
    });
    Object.assign(scores, parseJson<Record<string, Rating>>(row.legacy_scores_json, {}));
    return {
      id: row.id,
      documentId: row.document_id,
      fileName: row.file_name,
      fileSize: row.file_size,
      sha256: row.sha256,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      extractionMethod: row.extraction_method,
      selectedProviders: parseJson(row.selected_providers_json, ["ollama"]),
      results,
      scores,
      reviews,
      events: this.getEvents(id),
      pages: this.getPages(id),
      error: row.error,
      cacheHit: Boolean(row.cache_hit),
      cacheSourceRunId: row.cache_source_run_id,
      pipelineVersion: row.pipeline_version,
      schemaVersion: row.schema_version,
      parserFingerprint: row.parser_fingerprint,
      documentType: row.document_type,
      language: row.language,
      pageCount: row.page_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listExtractions(limit = 30): ExtractionView[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number.isFinite(limit) ? limit : 30)));
    const rows = this.connection.prepare("SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT ?").all(safeLimit) as unknown as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const extraction = this.getExtraction(row.id);
      return extraction ? [extraction] : [];
    });
  }

  getPrivatePath(runId: string): string | null {
    const row = this.connection.prepare(`
      SELECT d.file_path FROM pipeline_runs r JOIN documents d ON d.id = r.document_id WHERE r.id = ?
    `).get(runId) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  deleteExtraction(runId: string, reason = "user_requested"): { deleted: boolean; sourcePath: string | null; artifactPaths: string[]; documentDeleted: boolean } {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const row = this.connection.prepare(`
        SELECT r.document_id, d.sha256, d.file_path
        FROM pipeline_runs r JOIN documents d ON d.id = r.document_id
        WHERE r.id = ?
      `).get(runId) as { document_id: string; sha256: string; file_path: string } | undefined;
      if (!row) {
        this.connection.exec("COMMIT");
        return { deleted: false, sourcePath: null, artifactPaths: [], documentDeleted: false };
      }
      const artifacts = this.connection.prepare(`
        SELECT file_path FROM artifacts WHERE run_id = ? AND file_path IS NOT NULL
      `).all(runId) as unknown as Array<{ file_path: string }>;
      const otherRuns = this.connection.prepare(`
        SELECT COUNT(*) AS count FROM pipeline_runs WHERE document_id = ? AND id <> ?
      `).get(row.document_id, runId) as { count: number };
      this.connection.prepare(`
        INSERT INTO deletion_events (id, run_id, document_sha256, reason, deleted_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), runId, row.sha256, reason, new Date().toISOString());
      this.connection.prepare("DELETE FROM pipeline_runs WHERE id = ?").run(runId);
      if (otherRuns.count === 0) this.connection.prepare("DELETE FROM documents WHERE id = ?").run(row.document_id);
      this.connection.exec("COMMIT");
      return {
        deleted: true,
        sourcePath: otherRuns.count === 0 ? row.file_path : null,
        artifactPaths: artifacts.map((artifact) => artifact.file_path),
        documentDeleted: otherRuns.count === 0,
      };
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }
}
