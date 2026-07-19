import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LabDatabase } from "./database.js";

test("persists extraction history without exposing the private path", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rikms-lab-test-"));
  const database = new LabDatabase(path.join(directory, "test.sqlite"));
  try {
    database.insert({
      id: "job-1",
      fileName: "synthetic.pdf",
      filePath: "/private/synthetic.pdf",
      fileSize: 1234,
      sha256: "a".repeat(64),
      selectedProviders: ["ollama"],
    });
    database.update("job-1", { status: "completed", progress: 100, results: { ollama: { model: "qwen3.5:4b" } } });
    const record = database.get("job-1");
    assert.equal(record?.status, "completed");
    assert.deepEqual(record?.selectedProviders, ["ollama"]);
    assert.equal("filePath" in (record ?? {}), false);
    assert.equal(database.getPrivatePath("job-1"), "/private/synthetic.pdf");
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
