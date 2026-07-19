import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type ExtractionStatus = "queued" | "running" | "completed" | "failed";

export type StoredExtraction = {
  id: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  status: ExtractionStatus;
  stage: string;
  progress: number;
  extractionMethod: string | null;
  selectedProviders: string[];
  results: Record<string, unknown>;
  scores: Record<string, unknown>;
  events: Array<{ stage: string; message: string; at: string }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type DatabaseRow = {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number;
  sha256: string;
  status: ExtractionStatus;
  stage: string;
  progress: number;
  extraction_method: string | null;
  selected_providers_json: string;
  results_json: string;
  scores_json: string;
  events_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class LabDatabase {
  readonly connection: DatabaseSync;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.connection = new DatabaseSync(databasePath);
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS extractions (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL,
        extraction_method TEXT,
        selected_providers_json TEXT NOT NULL,
        results_json TEXT NOT NULL DEFAULT '{}',
        scores_json TEXT NOT NULL DEFAULT '{}',
        events_json TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    this.connection.exec(
      "CREATE INDEX IF NOT EXISTS extractions_created_at_idx ON extractions(created_at DESC)",
    );
  }

  insert(input: {
    id: string;
    fileName: string;
    filePath: string;
    fileSize: number;
    sha256: string;
    selectedProviders: string[];
  }): void {
    const timestamp = new Date().toISOString();
    this.connection
      .prepare(`
        INSERT INTO extractions (
          id, file_name, file_path, file_size, sha256, status, stage,
          progress, selected_providers_json, events_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', 'queued', 5, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.fileName,
        input.filePath,
        input.fileSize,
        input.sha256,
        JSON.stringify(input.selectedProviders),
        JSON.stringify([{ stage: "queued", message: "Extraction queued", at: timestamp }]),
        timestamp,
        timestamp,
      );
  }

  update(
    id: string,
    patch: Partial<{
      status: ExtractionStatus;
      stage: string;
      progress: number;
      extractionMethod: string;
      results: Record<string, unknown>;
      scores: Record<string, unknown>;
      events: StoredExtraction["events"];
      error: string | null;
    }>,
  ): void {
    const columns: string[] = [];
    const values: unknown[] = [];
    const mapping: Record<string, string> = {
      status: "status",
      stage: "stage",
      progress: "progress",
      extractionMethod: "extraction_method",
      results: "results_json",
      scores: "scores_json",
      events: "events_json",
      error: "error",
    };
    for (const [key, value] of Object.entries(patch)) {
      const column = mapping[key];
      if (!column) continue;
      columns.push(`${column} = ?`);
      values.push(["results", "scores", "events"].includes(key) ? JSON.stringify(value) : value);
    }
    if (columns.length === 0) return;
    columns.push("updated_at = ?");
    values.push(new Date().toISOString(), id);
    this.connection.prepare(`UPDATE extractions SET ${columns.join(", ")} WHERE id = ?`).run(...values);
  }

  appendEvent(id: string, stage: string, message: string): void {
    const record = this.get(id);
    if (!record) return;
    const events = [...record.events, { stage, message, at: new Date().toISOString() }].slice(-30);
    this.update(id, { events });
  }

  private map(row: DatabaseRow): StoredExtraction {
    return {
      id: row.id,
      fileName: row.file_name,
      fileSize: row.file_size,
      sha256: row.sha256,
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      extractionMethod: row.extraction_method,
      selectedProviders: parseJson(row.selected_providers_json, []),
      results: parseJson(row.results_json, {}),
      scores: parseJson(row.scores_json, {}),
      events: parseJson(row.events_json, []),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  get(id: string): StoredExtraction | null {
    const row = this.connection.prepare("SELECT * FROM extractions WHERE id = ?").get(id) as DatabaseRow | undefined;
    return row ? this.map(row) : null;
  }

  getPrivatePath(id: string): string | null {
    const row = this.connection.prepare("SELECT file_path FROM extractions WHERE id = ?").get(id) as { file_path: string } | undefined;
    return row?.file_path ?? null;
  }

  list(limit = 30): StoredExtraction[] {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    return (
      this.connection
        .prepare("SELECT * FROM extractions ORDER BY created_at DESC LIMIT ?")
        .all(safeLimit) as unknown as DatabaseRow[]
    ).map((row) => this.map(row));
  }

  close(): void {
    this.connection.close();
  }
}
