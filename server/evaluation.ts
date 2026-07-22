import type { ExtractionView, FieldResult, FieldValue, ProviderKey, SdgSuggestion } from "./contracts.js";
import { fieldDefinitions, type MetadataField } from "./schema.js";

export type GoldCase = {
  id: string;
  runId: string;
  provider?: ProviderKey;
  expected: Partial<Record<MetadataField, FieldValue>>;
  evidencePages?: Partial<Record<MetadataField, number[]>>;
};

export type EvaluationReport = {
  cases: number;
  evaluatedFields: number;
  macroFieldScore: number;
  evidencePageF1: number | null;
  autoAcceptedFields: number;
  autoAcceptedMeanScore: number | null;
  byField: Record<string, { samples: number; meanScore: number; evidencePageF1: number | null }>;
  failures: Array<{ caseId: string; field: string; score: number; expected: FieldValue; actual: FieldValue }>;
};

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function f1<T>(actual: Set<T>, expected: Set<T>): number {
  if (!actual.size && !expected.size) return 1;
  const overlap = [...actual].filter((item) => expected.has(item)).length;
  const precision = overlap / Math.max(1, actual.size);
  const recall = overlap / Math.max(1, expected.size);
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

function comparableSet(value: FieldValue): Set<string | number> {
  if (!Array.isArray(value)) return new Set();
  if (value.every((item) => typeof item === "object" && item !== null && "number" in item)) {
    return new Set((value as SdgSuggestion[]).map((item) => item.number));
  }
  return new Set((value as Array<string | number>).map((item) => typeof item === "string" ? normalize(item) : item));
}

export function scoreField(field: MetadataField, actual: FieldValue, expected: FieldValue): number {
  if (actual === null || expected === null) return actual === expected ? 1 : 0;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) ? f1(comparableSet(actual), comparableSet(expected)) : 0;
  }
  if (typeof actual === "number" || typeof expected === "number") {
    return typeof actual === "number" && typeof expected === "number" && Math.abs(actual - expected) <= 0.01 ? 1 : 0;
  }
  const definition = fieldDefinitions.find((candidate) => candidate.key === field);
  if (definition?.strategy === "grounded_summary") {
    return f1(new Set(normalize(actual).split(" ").filter(Boolean)), new Set(normalize(expected).split(" ").filter(Boolean)));
  }
  return normalize(actual) === normalize(expected) ? 1 : 0;
}

export function evaluateExtractions(cases: GoldCase[], extractions: Map<string, ExtractionView>): EvaluationReport {
  const fieldScores = new Map<string, number[]>();
  const evidenceScores = new Map<string, number[]>();
  const failures: EvaluationReport["failures"] = [];
  const automaticScores: number[] = [];
  for (const gold of cases) {
    const extraction = extractions.get(gold.runId);
    if (!extraction) throw new Error(`Gold case ${gold.id} references missing run ${gold.runId}.`);
    const provider = gold.provider ?? "ollama";
    const fields = extraction.results[provider]?.fields ?? {};
    for (const [field, expected] of Object.entries(gold.expected) as Array<[MetadataField, FieldValue]>) {
      if (expected === undefined) continue;
      const result = fields[field] as FieldResult | undefined;
      const actual = result?.value ?? null;
      const score = scoreField(field, actual, expected);
      fieldScores.set(field, [...(fieldScores.get(field) ?? []), score]);
      if (result?.status === "supported") automaticScores.push(score);
      if (score < 0.999) failures.push({ caseId: gold.id, field, score, expected, actual });
      const expectedPages = gold.evidencePages?.[field];
      if (expectedPages) {
        const actualPages = new Set(result?.evidence.map((evidence) => evidence.page) ?? []);
        const evidenceScore = f1(actualPages, new Set(expectedPages));
        evidenceScores.set(field, [...(evidenceScores.get(field) ?? []), evidenceScore]);
      }
    }
  }
  const allScores = [...fieldScores.values()].flat();
  const allEvidence = [...evidenceScores.values()].flat();
  const byField = Object.fromEntries([...fieldScores].map(([field, scores]) => {
    const evidence = evidenceScores.get(field) ?? [];
    return [field, {
      samples: scores.length,
      meanScore: scores.reduce((sum, score) => sum + score, 0) / scores.length,
      evidencePageF1: evidence.length ? evidence.reduce((sum, score) => sum + score, 0) / evidence.length : null,
    }];
  }));
  return {
    cases: cases.length,
    evaluatedFields: allScores.length,
    macroFieldScore: allScores.length ? allScores.reduce((sum, score) => sum + score, 0) / allScores.length : 0,
    evidencePageF1: allEvidence.length ? allEvidence.reduce((sum, score) => sum + score, 0) / allEvidence.length : null,
    autoAcceptedFields: automaticScores.length,
    autoAcceptedMeanScore: automaticScores.length ? automaticScores.reduce((sum, score) => sum + score, 0) / automaticScores.length : null,
    byField,
    failures,
  };
}
