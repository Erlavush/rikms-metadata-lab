export type ProviderKey = "ollama" | "api";

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting_review"
  | "completed"
  | "failed";

export type FieldStatus =
  | "pending"
  | "running"
  | "supported"
  | "needs_review"
  | "not_found"
  | "not_applicable"
  | "failed";

export type ReviewAction = "confirm" | "correct" | "not_found" | "not_applicable";
export type Rating = "correct" | "partial" | "incorrect";

export type FieldStrategy = "exact" | "normalized" | "grounded_summary" | "classification";

export type SdgSuggestion = {
  number: number;
  reason: string;
  confidence: number;
};

export type FieldValue = string | string[] | number[] | number | SdgSuggestion[] | null;

export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type EvidenceSpan = BoundingBox & {
  id?: string;
  blockId: string;
  page: number;
  quote: string;
  sourceEngine: string;
  exactMatch: boolean;
  semanticSupport: "supported" | "unsupported" | "not_checked";
  supportScore: number | null;
};

export type ValidationReport = {
  schema: "passed" | "failed";
  fieldRules: "passed" | "failed";
  evidence: "passed" | "failed" | "not_required";
  crossSource: "passed" | "conflict" | "not_checked";
  issues: string[];
};

export type FieldResult = {
  field: string;
  provider: ProviderKey;
  strategy: FieldStrategy;
  status: FieldStatus;
  value: FieldValue;
  method: string;
  evidence: EvidenceSpan[];
  rawAcceptanceScore: number;
  acceptanceScore: number;
  calibration: "uncalibrated" | "calibrated";
  reviewPriority: "low" | "medium" | "high";
  attempts: number;
  validation: ValidationReport;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error: string | null;
};

export type FieldAttempt = {
  id?: string;
  field: string;
  provider: ProviderKey;
  attempt: number;
  outcome: "accepted" | "rejected" | "not_found" | "error";
  candidateBlockIds: string[];
  result: FieldResult;
  createdAt?: string;
};

export type ProviderResult = {
  provider: ProviderKey;
  model: string;
  metadata: Record<string, unknown>;
  fields: Record<string, FieldResult>;
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

export type DocumentPage = PageQuality & {
  text: string;
};

export type DocumentBlock = BoundingBox & {
  id: string;
  page: number;
  type:
    | "title"
    | "heading"
    | "paragraph"
    | "list_item"
    | "table"
    | "caption"
    | "formula"
    | "footnote"
    | "header"
    | "footer"
    | "unknown";
  text: string;
  normalizedText: string;
  readingOrder: number;
  sectionPath: string[];
  sourceEngine: string;
  sourceConfidence: number | null;
  sourceIds: string[];
};

export type DocumentRecord = {
  id: string;
  sha256: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  mimeType: string;
  pageCount: number | null;
  documentType: string | null;
  language: string | null;
  createdAt: string;
};

export type AuditEvent = {
  sequence: number;
  stage: string;
  message: string;
  details: Record<string, unknown>;
  at: string;
};

export type ReviewRecord = {
  id: string;
  field: string;
  provider: ProviderKey;
  action: ReviewAction;
  rating: Rating | null;
  correctedValue: FieldValue;
  notes: string;
  reviewer: string;
  createdAt: string;
};

export type ExtractionView = {
  id: string;
  documentId: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  status: RunStatus;
  stage: string;
  progress: number;
  extractionMethod: string | null;
  selectedProviders: ProviderKey[];
  results: Partial<Record<ProviderKey, ProviderResult>>;
  scores: Record<string, Rating>;
  reviews: ReviewRecord[];
  events: AuditEvent[];
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

export type ParserCapability = {
  name: "native" | "tesseract" | "docling" | "grobid";
  configured: boolean;
  reachable: boolean;
  version: string | null;
  role: string;
};

export type SystemCapabilities = {
  parsers: ParserCapability[];
  durableQueue: boolean;
  calibratedConfidence: boolean;
  evidenceCoordinates: boolean;
  crossrefEnabled: boolean;
};
