import type { Extraction, FieldDefinition, FieldResult, FieldValue, ProviderKey, ProviderResult, SdgSuggestion } from "./types";

export const metadataFields: FieldDefinition[] = [
  { key: "title", label: "Title", order: 0, shape: "short", widths: [78, 92, 74, 76] },
  { key: "authors", label: "Authors", order: 1, shape: "short", widths: [80, 94, 76, 78] },
  { key: "abstract", label: "Abstract", order: 2, shape: "tall", widths: [70, 84, 68, 70, 68, 82, 64, 66] },
  { key: "keywords", label: "Keywords", order: 3, shape: "medium", widths: [76, 90, 72, 75] },
  { key: "methodology", label: "Methodology", order: 4, shape: "wide", widths: [78, 92, 74, 76] },
  { key: "review_of_related_literature", label: "Related Literature", order: 5, shape: "tall", widths: [82, 90, 68, 78, 72] },
  { key: "theoretical_framework", label: "Theoretical Framework", order: 6, shape: "medium", widths: [74, 88, 70, 76] },
  { key: "results_and_discussion", label: "Results & Discussion", order: 7, shape: "tall", widths: [88, 76, 92, 68, 80] },
  { key: "executive_summary", label: "Executive Summary", order: 8, shape: "medium", widths: [76, 92, 70, 84] },
  { key: "recommendations", label: "Recommendations", order: 9, shape: "medium", widths: [84, 72, 90, 68] },
  { key: "doi", label: "DOI", order: 10, shape: "short", widths: [74] },
  { key: "category", label: "Category", order: 11, shape: "short", widths: [68] },
  { key: "suggested_sdgs", label: "Suggested SDGs", order: 12, shape: "medium", widths: [82, 70, 88] },
  { key: "evidence_pages", label: "Evidence Pages", order: 13, shape: "short", widths: [72] },
  { key: "overall_confidence", label: "Acceptance Score", order: 14, shape: "short", widths: [58] },
];

export const metadataColumns = [
  metadataFields.filter((field) => field.order % 2 === 0),
  metadataFields.filter((field) => field.order % 2 === 1),
];

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatValue(field: string, value: unknown): string {
  if (field === "overall_confidence" && typeof value === "number") return `${Math.round(value * 100)}%`;
  if (field === "suggested_sdgs" && Array.isArray(value)) {
    return value.length
      ? (value as SdgSuggestion[]).map((item) => `SDG ${item.number} — ${item.reason} (${Math.round(item.confidence * 100)}%)`).join("\n")
      : "Not found";
  }
  if (Array.isArray(value)) return value.length ? value.join("\n") : "Not found";
  if (value === null || value === undefined || value === "") return "Not found";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function editorValue(field: string, value: unknown): string {
  if (field === "suggested_sdgs") return JSON.stringify(value ?? [], null, 2);
  if (Array.isArray(value)) return value.join("\n");
  if (value === null || value === undefined) return "";
  return String(value);
}

export function parseEditorValue(field: string, value: string): FieldValue {
  const trimmed = value.trim();
  if (field === "suggested_sdgs") return JSON.parse(trimmed || "[]") as SdgSuggestion[];
  if (["authors", "keywords", "recommendations", "evidence_pages"].includes(field)) {
    const separator = ["authors", "recommendations"].includes(field) ? /\r?\n/ : /\r?\n|,/;
    const items = trimmed.split(separator).map((item) => item.trim()).filter(Boolean);
    return field === "evidence_pages" ? items.map((item) => Number.parseInt(item, 10)).filter(Number.isFinite) : items;
  }
  if (field === "overall_confidence") {
    const numeric = Number.parseFloat(trimmed.replace("%", ""));
    return numeric > 1 ? numeric / 100 : numeric;
  }
  return trimmed;
}

export function fieldResult(provider: ProviderKey, result: ProviderResult, field: FieldDefinition): FieldResult {
  const rich = result.fields?.[field.key];
  if (rich) return rich;
  return {
    field: field.key,
    provider,
    strategy: "grounded_summary",
    status: "needs_review",
    value: result.metadata[field.key] as FieldValue,
    method: "legacy-whole-document",
    evidence: [],
    rawAcceptanceScore: field.key === "overall_confidence" && typeof result.metadata[field.key] === "number" ? Number(result.metadata[field.key]) : 0,
    acceptanceScore: field.key === "overall_confidence" && typeof result.metadata[field.key] === "number" ? Number(result.metadata[field.key]) : 0,
    calibration: "uncalibrated",
    reviewPriority: "high",
    attempts: 1,
    validation: { schema: "passed", fieldRules: "passed", evidence: "not_required", crossSource: "not_checked", issues: ["Legacy result has no field-level evidence."] },
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
    error: null,
  };
}

export function humanize(value: string | null | undefined): string {
  if (!value) return "Unknown";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\b(?:Api|Doi|Llm|Ocr|Pdf|Sdg)\b/g, (value) => value.toUpperCase());
}

export function latestProcessingStage(extraction: Pick<Extraction, "events" | "stage">): string {
  return [...extraction.events].reverse().find((event) => event.stage !== "failed")?.stage ?? extraction.stage;
}

export function runProgressLabel(extraction: Pick<Extraction, "progress" | "status">): string {
  if (extraction.status === "failed") {
    return extraction.progress > 0 && extraction.progress < 100
      ? `Stopped at ${extraction.progress}% processed.`
      : "Stopped before completion.";
  }
  if (extraction.status === "awaiting_review") return "Machine extraction finished; human review is required.";
  if (extraction.status === "completed") return "Extraction and human review complete.";
  if (extraction.status === "queued") return "Queued for local processing.";
  return `${extraction.progress}% processed.`;
}
