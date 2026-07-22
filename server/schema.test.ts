import assert from "node:assert/strict";
import test from "node:test";
import { metadataFields, rikmsMetadataValidator } from "./schema.js";

const valid = Object.fromEntries(
  metadataFields.map((field) => [field, ["keywords", "authors", "recommendations", "suggested_sdgs", "evidence_pages"].includes(field) ? [] : ""]),
) as Record<string, unknown>;
valid.overall_confidence = 0.8;

test("accepts canonical RIKMS metadata", () => {
  assert.equal(rikmsMetadataValidator.parse(valid).overall_confidence, 0.8);
});

test("rejects unknown model fields", () => {
  assert.throws(() => rikmsMetadataValidator.parse({ ...valid, published: true }));
});

test("rejects out-of-range SDGs", () => {
  assert.throws(() =>
    rikmsMetadataValidator.parse({
      ...valid,
      suggested_sdgs: [{ number: 18, reason: "Unsupported", confidence: 1 }],
    }),
  );
});

test("enforces the reviewed top-three SDG contract", () => {
  assert.throws(() =>
    rikmsMetadataValidator.parse({
      ...valid,
      suggested_sdgs: [3, 6, 11, 13].map((number) => ({ number, reason: "Document-supported goal", confidence: 0.8 })),
    }),
  );
});
