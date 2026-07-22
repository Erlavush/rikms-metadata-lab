export type ProviderKey = "ollama" | "api";
export type Rating = "correct" | "partial" | "incorrect";
export type ReviewAction = "confirm" | "correct" | "not_found" | "not_applicable";
export type FieldValue = string | string[] | number[] | number | SdgSuggestion[] | null;

export type SdgSuggestion = {
  number: number;
  reason: string;
  confidence: number;
};

export type EvidenceSpan = {
  blockId: string;
  page: number;
  quote: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sourceEngine: string;
  exactMatch: boolean;
  semanticSupport: "supported" | "unsupported" | "not_checked";
  supportScore: number | null;
};

export type FieldResult = {
  field: string;
  provider: ProviderKey;
  strategy: "exact" | "normalized" | "grounded_summary" | "classification";
  status: "pending" | "running" | "supported" | "needs_review" | "not_found" | "not_applicable" | "failed";
  value: FieldValue;
  method: string;
  evidence: EvidenceSpan[];
  rawAcceptanceScore: number;
  acceptanceScore: number;
  calibration: "uncalibrated" | "calibrated";
  reviewPriority: "low" | "medium" | "high";
  attempts: number;
  validation: {
    schema: "passed" | "failed";
    fieldRules: "passed" | "failed";
    evidence: "passed" | "failed" | "not_required";
    crossSource: "passed" | "conflict" | "not_checked";
    issues: string[];
  };
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error: string | null;
};

export type ProviderResult = {
  provider: ProviderKey;
  model: string;
  metadata: Record<string, unknown>;
  fields?: Record<string, FieldResult>;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  estimatedCostUsd: number | null;
};

export type PageQuality = {
  page: number;
  width: number;
  height: number;
  nativeCharacters: number;
  nativeWords: number;
  replacementRatio: number;
  parseScore: number;
  grade: "poor" | "fair" | "good" | "excellent";
  reasons: string[];
  ocrApplied: boolean;
  sourceEngine: string;
};

export type Extraction = {
  id: string;
  documentId: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  status: "queued" | "running" | "awaiting_review" | "completed" | "failed";
  stage: string;
  progress: number;
  extractionMethod: string | null;
  selectedProviders: ProviderKey[];
  results: Partial<Record<ProviderKey, ProviderResult>>;
  scores: Record<string, Rating>;
  reviews: Array<{
    id: string;
    field: string;
    provider: ProviderKey;
    action: ReviewAction;
    rating: Rating | null;
    correctedValue: FieldValue;
    notes: string;
    reviewer: string;
    createdAt: string;
  }>;
  events: Array<{ sequence?: number; stage: string; message: string; details?: Record<string, unknown>; at: string }>;
  pages: PageQuality[];
  error: string | null;
  cacheHit: boolean;
  cacheSourceRunId: string | null;
  pipelineVersion: string;
  schemaVersion: string;
  parserFingerprint: string;
  documentType: string | null;
  language: string | null;
  pageCount: number | null;
  createdAt: string;
  updatedAt: string;
};

export type LabConfig = {
  maxUploadMb: number;
  maxPages: number;
  pipelineVersion: string;
  schemaVersion: string;
  parserFingerprint: string;
  providers: {
    ollama: { configured: boolean; reachable: boolean | null; model: string; models: string[] };
    api: { configured: boolean; reachable: boolean | null; model: string };
  };
  capabilities: {
    parsers: Array<{ name: string; configured: boolean; reachable: boolean; version: string | null; role: string }>;
    durableQueue: boolean;
    calibratedConfidence: boolean;
    evidenceCoordinates: boolean;
    crossrefEnabled: boolean;
  };
};

export type FieldDefinition = {
  key: string;
  label: string;
  order: number;
  shape: "short" | "medium" | "tall" | "wide";
  widths: number[];
};

export type EvidenceSelection = {
  evidence: EvidenceSpan;
  fieldLabel: string;
  model: string;
};
