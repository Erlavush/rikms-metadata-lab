import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { FieldResult } from "./contracts.js";
import { loadLabConfig } from "./config.js";
import { createLabRuntime } from "./index.js";
import { writeSyntheticPdf } from "./test-pdf.js";

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rikms-api-test-"));
  const config = {
    ...loadLabConfig(directory),
    doclingMode: "off" as const,
    grobidMode: "off" as const,
  };
  const runtime = createLabRuntime(config);
  runtime.worker.stop();
  const server = await new Promise<Server>((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
  return { directory, runtime, server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeFixture(value: Awaited<ReturnType<typeof fixture>>) {
  await new Promise<void>((resolve, reject) => value.server.close((error) => error ? reject(error) : resolve()));
  value.runtime.close();
  rmSync(value.directory, { recursive: true, force: true });
}

function titleFieldResult(): FieldResult {
  return {
    field: "title",
    provider: "ollama",
    strategy: "exact",
    status: "supported",
    value: "A Quality Rating Fixture",
    method: "layout-title",
    evidence: [],
    rawAcceptanceScore: 0.8,
    acceptanceScore: 0.8,
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

test("reports runtime capabilities and rejects invalid PDF bytes without residue", async () => {
  const value = await fixture();
  try {
    const health = await fetch(`${value.baseUrl}/api/health`).then((response) => response.json()) as { ok?: boolean; durableQueue?: boolean };
    assert.equal(health.ok, true);
    assert.equal(health.durableQueue, true);
    const form = new FormData();
    form.append("paper", new Blob(["not a pdf"], { type: "application/pdf" }), "fake.pdf");
    form.append("providers", '["ollama"]');
    const response = await fetch(`${value.baseUrl}/api/extractions`, { method: "POST", body: form });
    assert.equal(response.status, 422);
    assert.deepEqual(readdirSync(value.runtime.config.uploadDirectory), []);
    const list = await fetch(`${value.baseUrl}/api/extractions`).then((result) => result.json()) as { extractions?: unknown[] };
    assert.equal(list.extractions?.length, 0);
  } finally {
    await closeFixture(value);
  }
});

test("does not delete a committed source PDF if run creation fails", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.directory, "source.pdf");
    writeSyntheticPdf(source, [["A SAFE RESEARCH PROPOSAL", "ABSTRACT", "A bounded integration fixture."]]);
    const bytes = readFileSync(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    value.runtime.database.createRun = (() => { throw new Error("simulated run failure"); }) as typeof value.runtime.database.createRun;
    const form = new FormData();
    form.append("paper", new Blob([bytes], { type: "application/pdf" }), "source.pdf");
    form.append("providers", '["ollama"]');
    const response = await fetch(`${value.baseUrl}/api/extractions`, { method: "POST", body: form });
    assert.equal(response.status, 500);
    const document = value.runtime.database.getDocumentByHash(sha256);
    assert.ok(document);
    assert.equal(existsSync(document.filePath), true);
  } finally {
    await closeFixture(value);
  }
});

test("requires confirmation and removes only an inactive private run", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.directory, "deletion-source.pdf");
    writeSyntheticPdf(source, [["A DELETION TEST PROPOSAL", "ABSTRACT", "A privacy lifecycle fixture."]]);
    const bytes = readFileSync(source);
    const form = new FormData();
    form.append("paper", new Blob([bytes], { type: "application/pdf" }), "deletion-source.pdf");
    form.append("providers", '["ollama"]');
    const uploaded = await fetch(`${value.baseUrl}/api/extractions`, { method: "POST", body: form });
    assert.equal(uploaded.status, 202);
    const record = await uploaded.json() as { id: string };
    const activeDelete = await fetch(`${value.baseUrl}/api/extractions/${record.id}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(activeDelete.status, 409);
    const privateError = "open '/home/eru/private/source.pdf' failed";
    value.runtime.database.updateRun(record.id, { status: "failed", stage: "failed", progress: 44, error: privateError });
    value.runtime.database.appendEvent(record.id, "failed", privateError, { artifact: "/home/eru/private/page.png" });
    const publicRecord = await fetch(`${value.baseUrl}/api/extractions/${record.id}`).then((response) => response.json()) as {
      error: string;
      events: Array<{ message: string; details: { artifact?: string } }>;
    };
    assert.equal(publicRecord.error.includes("/home/"), false);
    assert.equal(publicRecord.events.at(-1)?.message.includes("/home/"), false);
    assert.equal(publicRecord.events.at(-1)?.details.artifact, "[private path]");
    const missingConfirmation = await fetch(`${value.baseUrl}/api/extractions/${record.id}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: false }),
    });
    assert.equal(missingConfirmation.status, 422);
    const privatePath = value.runtime.database.getPrivatePath(record.id);
    const deleted = await fetch(`${value.baseUrl}/api/extractions/${record.id}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }),
    });
    assert.equal(deleted.status, 200);
    assert.equal(value.runtime.database.getExtraction(record.id), null);
    assert.equal(privatePath ? existsSync(privatePath) : true, false);
  } finally {
    await closeFixture(value);
  }
});

test("quality score endpoint colors a field without completing its review", async () => {
  const value = await fixture();
  try {
    const source = path.join(value.directory, "quality-source.pdf");
    writeSyntheticPdf(source, [["A QUALITY RATING FIXTURE", "ABSTRACT", "A bounded quality-rating fixture."]]);
    const bytes = readFileSync(source);
    const form = new FormData();
    form.append("paper", new Blob([bytes], { type: "application/pdf" }), "quality-source.pdf");
    form.append("providers", '["ollama"]');
    const uploaded = await fetch(`${value.baseUrl}/api/extractions`, { method: "POST", body: form });
    const record = await uploaded.json() as { id: string };
    value.runtime.database.saveFieldResult(record.id, titleFieldResult());
    value.runtime.database.updateRun(record.id, { status: "awaiting_review", stage: "awaiting_review", progress: 100 });

    const response = await fetch(`${value.baseUrl}/api/extractions/${record.id}/scores`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scores: { "ollama.title": "partial" } }),
    });
    assert.equal(response.status, 200);
    const extraction = await response.json() as { status: string; scores: Record<string, string>; reviews: unknown[] };
    assert.equal(extraction.scores["ollama.title"], "partial");
    assert.equal(extraction.reviews.length, 0);
    assert.equal(extraction.status, "awaiting_review");
  } finally {
    await closeFixture(value);
  }
});
