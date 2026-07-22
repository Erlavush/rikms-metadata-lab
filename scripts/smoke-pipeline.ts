import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadLabConfig } from "../server/config.js";
import { LabDatabase } from "../server/database.js";
import { PipelineWorker } from "../server/pipeline.js";
import { writeSyntheticPdf } from "../server/test-pdf.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "rikms-pipeline-smoke-"));
const filePath = path.join(directory, "synthetic-proposal.pdf");
const filler = "The project uses transparent procedures, documented instruments, reproducible analysis, ethical safeguards, and community consultation.";
writeSyntheticPdf(filePath, [[
  "COMMUNITY WATER QUALITY MONITORING: A RESEARCH PROPOSAL",
  "BY",
  "Alex Rivera and Jordan Santos",
  "ABSTRACT",
  "This proposal examines household water quality and community health through surveys and laboratory testing.",
  "Keywords: water quality; public health; community monitoring",
  "METHODOLOGY",
  "Researchers will use stratified sampling to recruit one hundred households, administer a validated survey, collect water samples, and analyze bacterial indicators using descriptive statistics.",
  filler, filler, filler, filler,
  "REVIEW OF RELATED LITERATURE",
  "Prior community monitoring studies associate transparent sampling and resident participation with more useful local environmental evidence.",
  filler, filler, filler,
  "THEORETICAL FRAMEWORK",
  "The study applies community-based participatory research to connect resident knowledge, measurement practice, and local decision making.",
  filler, filler, filler,
  "EXECUTIVE SUMMARY",
  "The proposed work combines household surveys and water testing to produce evidence for community health planning.",
  filler, filler, filler, filler,
]]);

const config = {
  ...loadLabConfig(),
  dataDirectory: path.join(directory, ".data"),
  uploadDirectory: path.join(directory, ".data", "uploads"),
  artifactDirectory: path.join(directory, ".data", "artifacts"),
  databasePath: path.join(directory, ".data", "smoke.sqlite"),
  doclingMode: "off" as const,
  grobidMode: "off" as const,
  ocrThreshold: 0,
  maximumFieldAttempts: 1,
  maximumPages: 20,
};
const database = new LabDatabase(config.databasePath);
const worker = new PipelineWorker(database, config);
try {
  const bytes = readFileSync(filePath);
  const document = database.upsertDocument({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    fileName: "synthetic-proposal.pdf",
    filePath,
    fileSize: bytes.length,
    mimeType: "application/pdf",
  }).document;
  const runId = database.createRun({
    documentId: document.id,
    cacheKey: "pipeline-smoke",
    parserFingerprint: "pipeline-smoke",
    selectedProviders: ["ollama"],
    config: { purpose: "local end-to-end smoke test" },
  });
  worker.start();
  const deadline = Date.now() + 15 * 60_000;
  let record = database.getExtraction(runId)!;
  while (["queued", "running"].includes(record.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    record = database.getExtraction(runId)!;
  }
  if (["queued", "running"].includes(record.status)) throw new Error("Pipeline smoke test exceeded fifteen minutes.");
  if (record.status === "failed") throw new Error(record.error ?? "Pipeline smoke test failed.");
  const fields = Object.values(record.results.ollama?.fields ?? {});
  if (fields.length !== 15) throw new Error(`Expected 15 field results, received ${fields.length}.`);
  const statusCounts = Object.fromEntries([...new Set(fields.map((field) => field.status))].map((status) => [status, fields.filter((field) => field.status === status).length]));
  const blocks = database.getBlocks(runId);
  process.stdout.write(`${JSON.stringify({
    status: record.status,
    documentType: record.documentType,
    extractionMethod: record.extractionMethod,
    pages: record.pages.length,
    fields: fields.length,
    structure: {
      blocks: blocks.length,
      headings: blocks.filter((block) => block.type === "heading").map((block) => block.text),
      sections: [...new Set(blocks.flatMap((block) => block.sectionPath))],
    },
    fieldAttempts: database.getFieldAttempts(runId).length,
    evidenceSpans: fields.reduce((sum, field) => sum + field.evidence.length, 0),
    statusCounts,
    fieldRouting: Object.fromEntries(fields.map((field) => [field.field, {
      status: field.status,
      method: field.method,
      evidence: field.evidence.length,
      issues: field.validation.issues,
    }])),
    events: record.events.length,
  }, null, 2)}\n`);
} finally {
  worker.stop();
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
