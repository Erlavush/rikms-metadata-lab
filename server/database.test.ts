import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { FieldResult } from "./contracts.js";
import { LabDatabase } from "./database.js";

function fieldResult(score = 0.8): FieldResult {
  return {
    field: "title",
    provider: "ollama",
    strategy: "exact",
    status: "supported",
    value: "Synthetic Research Title",
    method: "layout-title",
    evidence: [],
    rawAcceptanceScore: score,
    acceptanceScore: score,
    calibration: "uncalibrated",
    reviewPriority: "low",
    attempts: 1,
    validation: { schema: "passed", fieldRules: "passed", evidence: "not_required", crossSource: "not_checked", issues: [] },
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 1,
    error: null,
  };
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rikms-lab-test-"));
  const database = new LabDatabase(path.join(directory, "test.sqlite"));
  const document = database.upsertDocument({
    sha256: "a".repeat(64),
    fileName: "synthetic.pdf",
    filePath: path.join(directory, "synthetic.pdf"),
    fileSize: 1234,
    mimeType: "application/pdf",
  }).document;
  return { directory, database, document };
}

test("persists normalized extraction history without exposing the private path", () => {
  const { directory, database, document } = fixture();
  try {
    const runId = database.createRun({
      documentId: document.id,
      cacheKey: "cache-key",
      parserFingerprint: "parser-fingerprint",
      selectedProviders: ["ollama"],
      config: {},
    });
    database.updateRun(runId, { status: "awaiting_review", stage: "awaiting_review", progress: 100 });
    const record = database.getExtraction(runId);
    assert.equal(record?.status, "awaiting_review");
    assert.deepEqual(record?.selectedProviders, ["ollama"]);
    assert.equal("filePath" in (record ?? {}), false);
    assert.equal(database.getPrivatePath(runId), document.filePath);
    assert.equal(database.findCompatibleRun("cache-key")?.id, runId);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claims queued work once and recovers an expired lease", () => {
  const { directory, database, document } = fixture();
  try {
    const runId = database.createRun({
      documentId: document.id,
      cacheKey: "recovery-key",
      parserFingerprint: "parser-fingerprint",
      selectedProviders: ["ollama"],
      config: {},
    });
    assert.equal(database.claimNextRun("worker-a", -1)?.id, runId);
    assert.equal(database.claimNextRun("worker-b", 60_000)?.id, runId);
    assert.equal(database.recoverExpiredRuns(), 0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stores every field attempt separately from the final result", () => {
  const { directory, database, document } = fixture();
  try {
    const runId = database.createRun({
      documentId: document.id,
      cacheKey: "attempt-key",
      parserFingerprint: "parser-fingerprint",
      selectedProviders: ["ollama"],
      config: {},
    });
    const result = fieldResult();
    database.saveFieldAttempt(runId, { field: "title", provider: "ollama", attempt: 1, outcome: "rejected", candidateBlockIds: ["b1"], result: { ...result, status: "needs_review" } });
    database.saveFieldAttempt(runId, { field: "title", provider: "ollama", attempt: 2, outcome: "accepted", candidateBlockIds: ["b2"], result: { ...result, attempts: 2 } });
    database.saveFieldResult(runId, { ...result, attempts: 2 });
    const attempts = database.getFieldAttempts(runId, "ollama", "title");
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map((attempt) => attempt.outcome), ["rejected", "accepted"]);
    assert.equal(database.getFieldResults(runId).length, 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stores quality ratings without creating authoritative review decisions", () => {
  const { directory, database, document } = fixture();
  try {
    const runId = database.createRun({
      documentId: document.id,
      cacheKey: "quality-rating-key",
      parserFingerprint: "parser-fingerprint",
      selectedProviders: ["ollama"],
      config: {},
    });
    database.saveFieldResult(runId, fieldResult());
    database.updateRun(runId, { status: "awaiting_review", stage: "awaiting_review", progress: 100 });
    assert.equal(database.setQualityRatings(runId, { "ollama.title": "partial" }), true);
    const record = database.getExtraction(runId);
    assert.equal(record?.scores["ollama.title"], "partial");
    assert.equal(record?.reviews.length, 0);
    assert.equal(record?.status, "awaiting_review");
    assert.equal(record?.events.at(-1)?.stage, "quality_rating");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("activates empirical calibration only after twenty reviewed outcomes", () => {
  const { directory, database } = fixture();
  try {
    for (let index = 0; index < 20; index += 1) {
      const document = database.upsertDocument({
        sha256: index.toString(16).padStart(64, "0"),
        fileName: `case-${index}.pdf`,
        filePath: path.join(directory, `case-${index}.pdf`),
        fileSize: 100 + index,
        mimeType: "application/pdf",
      }).document;
      const runId = database.createRun({
        documentId: document.id,
        cacheKey: `calibration-${index}`,
        parserFingerprint: "parser-fingerprint",
        selectedProviders: ["ollama"],
        config: {},
      });
      database.saveFieldResult(runId, fieldResult(index < 10 ? 0.2 : 0.8));
      database.addReview(runId, {
        provider: "ollama",
        field: "title",
        action: index < 10 ? "not_found" : "confirm",
        rating: index < 10 ? "incorrect" : "correct",
        correctedValue: index < 10 ? "" : "Synthetic Research Title",
        notes: "Calibration fixture",
        reviewer: "test-reviewer",
      });
      if (index === 18) assert.equal(database.hasCalibrationProfiles(), false);
    }
    assert.equal(database.hasCalibrationProfiles(), true);
    assert.equal(database.calibrate("ollama", "title", 0.8).calibrated, true);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates legacy extraction rows without deleting the legacy table", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rikms-legacy-test-"));
  const databasePath = path.join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE extractions (
      id TEXT PRIMARY KEY, file_name TEXT, file_path TEXT, file_size INTEGER, sha256 TEXT,
      selected_providers_json TEXT, status TEXT, stage TEXT, progress INTEGER,
      extraction_method TEXT, error TEXT, results_json TEXT, scores_json TEXT,
      events_json TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO extractions VALUES (
      'legacy-run', 'legacy.pdf', '/private/legacy.pdf', 42, '${"f".repeat(64)}',
      '["ollama"]', 'completed', 'completed', 100, 'pdftotext', NULL,
      '{}', '{}', '[{"stage":"completed","message":"Legacy complete","at":"2025-01-01T00:00:00.000Z"}]',
      '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
    );
  `);
  legacy.close();
  const database = new LabDatabase(databasePath);
  try {
    assert.equal(database.getExtraction("legacy-run")?.fileName, "legacy.pdf");
    const table = database.connection.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'extractions'").get() as { present: number };
    assert.equal(table.present, 1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
