import assert from "node:assert/strict";
import test from "node:test";
import { modelForRun } from "./pipeline.js";

test("uses the model persisted with each run", () => {
  assert.equal(modelForRun("qwen3.5:4b", { model: "gemma2:2b" }), "gemma2:2b");
  assert.equal(modelForRun("qwen3.5:4b", {}), "qwen3.5:4b");
  assert.equal(modelForRun("qwen3.5:4b", { model: "unsafe model" }), "qwen3.5:4b");
});
