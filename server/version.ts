import { createHash } from "node:crypto";

export const PIPELINE_VERSION = "2.0.9";
export const SCHEMA_VERSION = "2.0.2";
export const PROMPT_VERSION = "2.0.5";
export const TAXONOMY_VERSION = "rikms-2026.1";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createPipelineFingerprint(input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      stableJson({
        pipelineVersion: PIPELINE_VERSION,
        schemaVersion: SCHEMA_VERSION,
        promptVersion: PROMPT_VERSION,
        taxonomyVersion: TAXONOMY_VERSION,
        ...input,
      }),
    )
    .digest("hex");
}

export function createCacheKey(sha256: string, fingerprint: string, providers: string[]): string {
  return createHash("sha256")
    .update(`${sha256}:${fingerprint}:${[...providers].sort().join(",")}`)
    .digest("hex");
}
