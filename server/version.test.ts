import assert from "node:assert/strict";
import test from "node:test";
import { createCacheKey, createPipelineFingerprint } from "./version.js";

test("produces stable fingerprints and provider-order-independent cache keys", () => {
  const left = createPipelineFingerprint({ z: 1, parsers: { native: "25" }, a: [2, 1] });
  const right = createPipelineFingerprint({ a: [2, 1], parsers: { native: "25" }, z: 1 });
  assert.equal(left, right);
  assert.equal(createCacheKey("a".repeat(64), left, ["api", "ollama"]), createCacheKey("a".repeat(64), left, ["ollama", "api"]));
  assert.notEqual(createCacheKey("a".repeat(64), left, ["ollama"]), createCacheKey("b".repeat(64), left, ["ollama"]));
});
