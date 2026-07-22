import assert from "node:assert/strict";
import test from "node:test";
import {
  localVerificationModel,
  ollamaInventoryHasModel,
  ollamaInventoryNames,
  resolveInstalledOllamaModel,
  runningOllamaModelNames,
  semanticVerificationGuidance,
  stripInternalEvidenceFraming,
} from "./extraction.js";

test("uses the selected local model for the second-pass verifier", () => {
  assert.equal(localVerificationModel({ ollamaModel: "qwen3.5:4b" }), "qwen3.5:4b");
  assert.equal(localVerificationModel({ ollamaModel: "gemma2:2b" }), "gemma2:2b");
});

test("matches requested models against Ollama inventory aliases", () => {
  const inventory = [{ name: "qwen3.5:4b" }, { model: "gemma2:latest" }];
  assert.equal(ollamaInventoryHasModel(inventory, "qwen3.5:4b"), true);
  assert.equal(ollamaInventoryHasModel(inventory, "gemma2"), true);
  assert.equal(ollamaInventoryHasModel(inventory, "missing:7b"), false);
});

test("exposes every safe installed Ollama model and resolves aliases", () => {
  const inventory = [
    { name: "qwen3.5:4b" },
    { model: "gemma2:2b" },
    { name: "research/model:latest" },
    { name: "qwen3.5:4b" },
    { name: "unsafe model name" },
  ];
  const names = ollamaInventoryNames(inventory);
  assert.deepEqual(names, ["gemma2:2b", "qwen3.5:4b", "research/model:latest"]);
  assert.equal(resolveInstalledOllamaModel(names, "research/model"), "research/model:latest");
  assert.equal(resolveInstalledOllamaModel(names, "missing:7b"), null);
});

test("identifies every resident Ollama model before a serialized model switch", () => {
  assert.deepEqual(runningOllamaModelNames({ models: [
    { name: "qwen3.5:4b", model: "qwen3.5:4b" },
    { name: "gemma2:2b", model: "gemma2:2b" },
    { name: 42 },
  ] }), ["qwen3.5:4b", "gemma2:2b"]);
});

test("removes internal evidence framing from model values", () => {
  assert.equal(
    stripInternalEvidenceFraming("[BLOCK native-p2-b1 | PAGE 2 | PARAGRAPH | SECTION Introduction] Supported source text."),
    "Supported source text.",
  );
  assert.deepEqual(stripInternalEvidenceFraming([{ reason: "[BLOCK b2 | PAGE 3 | PARAGRAPH | SECTION Results] Direct support." }]), [
    { reason: "Direct support." },
  ]);
});

test("category verification evaluates the document subject rather than its institution", () => {
  const guidance = semanticVerificationGuidance("category");
  assert.match(guidance, /document's research subject/i);
  assert.match(guidance, /not an author, affiliation, or institution/i);
  assert.match(guidance, /mathematics, physics/i);
});
