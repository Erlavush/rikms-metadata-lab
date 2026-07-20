"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Skeleton, { SkeletonTheme } from "react-loading-skeleton";

const API_URL = process.env.NEXT_PUBLIC_LAB_API_URL ?? "http://127.0.0.1:8787";
const MAX_BYTES = 25 * 1024 * 1024;

type ProviderKey = "ollama" | "api";
type Rating = "correct" | "partial" | "incorrect";

type ProviderResult = {
  provider: ProviderKey;
  model: string;
  metadata: Record<string, unknown>;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  estimatedCostUsd: number | null;
};

type Extraction = {
  id: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: string;
  progress: number;
  extractionMethod: string | null;
  selectedProviders: ProviderKey[];
  results: Partial<Record<ProviderKey, ProviderResult>>;
  scores: Record<string, Rating>;
  events: Array<{ stage: string; message: string; at: string }>;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type LabConfig = {
  maxUploadMb: number;
  providers: Record<ProviderKey, { configured: boolean; reachable: boolean | null; model: string }>;
};

type FieldDefinition = {
  key: string;
  label: string;
  order: number;
  shape: "short" | "medium" | "tall" | "wide";
  widths: number[];
};

const phases = [
  ["validating", "Validating PDF"],
  ["extracting_text", "Reading the paper"],
  ["running_models", "Qwen is extracting metadata"],
  ["validating_schema", "Checking the RIKMS schema"],
  ["completed", "Metadata ready"],
] as const;

const metadataFields: FieldDefinition[] = [
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
  { key: "overall_confidence", label: "Model Confidence", order: 14, shape: "short", widths: [58] },
];

const metadataColumns = [
  metadataFields.filter((field) => field.order % 2 === 0),
  metadataFields.filter((field) => field.order % 2 === 1),
];

const ratingOptions: Array<{ value: Rating; label: string; symbol: string }> = [
  { value: "correct", label: "Correct", symbol: "✓" },
  { value: "partial", label: "Partly correct", symbol: "~" },
  { value: "incorrect", label: "Incorrect", symbol: "×" },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed with HTTP ${response.status}.`);
  return payload;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function formatValue(field: string, value: unknown): string {
  if (field === "overall_confidence" && typeof value === "number") return `${Math.round(value * 100)}%`;
  if (field === "suggested_sdgs" && Array.isArray(value)) {
    return value.length
      ? value
          .map((item) => {
            const sdg = item as { number?: number; reason?: string; confidence?: number };
            return `SDG ${sdg.number} — ${sdg.reason || "No reason"} (${Math.round((sdg.confidence ?? 0) * 100)}%)`;
          })
          .join("\n")
      : "Not found";
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Not found";
  if (value === null || value === undefined || value === "") return "Not found";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function UploadIcon() {
  return (
    <svg className="upload-icon" viewBox="0 0 96 96" aria-hidden="true">
      <path d="M48 67V16M48 16 29 35M48 16l19 19" />
      <path d="M18 65v9c0 8 6 14 14 14h32c8 0 14-6 14-14v-9" />
    </svg>
  );
}

function LoadingSpinner() {
  return <span className="button-spinner" aria-hidden="true" />;
}

function PlaceholderLines({ widths }: { widths: number[] }) {
  return (
    <div className="placeholder-lines" aria-hidden="true">
      {widths.map((width, index) => (
        <span key={`${width}-${index}`} style={{ inlineSize: `${width}%` }} />
      ))}
    </div>
  );
}

function ShimmerLines({ widths }: { widths: number[] }) {
  return (
    <div className="shimmer-lines" aria-hidden="true">
      {widths.map((width, index) => (
        <Skeleton
          key={`${width}-${index}`}
          width={`${width}%`}
          height="var(--skeleton-line-height)"
        />
      ))}
    </div>
  );
}

function RatingRail({
  field,
  provider,
  model,
  scores,
  onRate,
}: {
  field: FieldDefinition;
  provider: ProviderKey;
  model: string;
  scores: Record<string, Rating>;
  onRate: (key: string, rating: Rating) => void;
}) {
  const scoreKey = `${provider}.${field.key}`;
  return (
    <div className="rating-rail" aria-label={`Rate ${field.label} from ${model}`}>
      {ratingOptions.map((option) => (
        <button
          className={`rating-dot rating-${option.value}`}
          data-selected={scores[scoreKey] === option.value}
          key={option.value}
          type="button"
          aria-label={`${option.label}: ${field.label} from ${model}`}
          aria-pressed={scores[scoreKey] === option.value}
          title={option.label}
          onClick={() => onRate(scoreKey, option.value)}
        >
          <span aria-hidden="true">{option.symbol}</span>
        </button>
      ))}
    </div>
  );
}

function MetadataCard({
  field,
  busy,
  results,
  scores,
  onRate,
}: {
  field: FieldDefinition;
  busy: boolean;
  results: Array<[ProviderKey, ProviderResult]>;
  scores: Record<string, Rating>;
  onRate: (key: string, rating: Rating) => void;
}) {
  const hasResults = results.length > 0;
  const singleResultRating =
    results.length === 1 ? scores[`${results[0][0]}.${field.key}`] : undefined;
  return (
    <section
      className={`metadata-block metadata-${field.shape}${field.order > 4 ? " metadata-secondary" : ""}`}
      style={{ order: field.order }}
      aria-labelledby={`field-${field.key}`}
    >
      <h2 id={`field-${field.key}`}>{field.label}</h2>
      <div
        className={`metadata-card ${busy ? "is-loading" : !hasResults ? "is-placeholder" : ""} ${hasResults && results.length > 1 ? "is-comparison" : ""} ${singleResultRating ? `is-${singleResultRating}` : ""}`}
        aria-busy={busy}
      >
        {busy ? (
          <ShimmerLines widths={field.widths} />
        ) : hasResults ? (
          results.map(([provider, result]) => (
            <div
              className={`provider-result ${results.length > 1 && scores[`${provider}.${field.key}`] ? `is-${scores[`${provider}.${field.key}`]}` : ""}`}
              key={provider}
            >
              {results.length > 1 ? <span className="provider-label">{result.model}</span> : null}
              <p>{formatValue(field.key, result.metadata[field.key])}</p>
              <RatingRail field={field} provider={provider} model={result.model} scores={scores} onRate={onRate} />
            </div>
          ))
        ) : (
          <PlaceholderLines widths={field.widths} />
        )}
      </div>
    </section>
  );
}

export default function Home() {
  const [config, setConfig] = useState<LabConfig | null>(null);
  const [history, setHistory] = useState<Extraction[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [providers, setProviders] = useState<ProviderKey[]>(["ollama"]);
  const [selectedOllamaModel, setSelectedOllamaModel] = useState<string>("qwen3.5:4b");
  const [active, setActive] = useState<Extraction | null>(null);
  const [scores, setScores] = useState<Record<string, Rating>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [evaluationSaved, setEvaluationSaved] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    const payload = await api<{ extractions: Extraction[] }>("/api/extractions?limit=25");
    setHistory(payload.extractions);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<LabConfig>("/api/config", { signal: controller.signal }),
      api<{ extractions: Extraction[] }>("/api/extractions?limit=25", { signal: controller.signal }),
    ])
      .then(([nextConfig, nextHistory]) => {
        setConfig(nextConfig);
        setHistory(nextHistory.extractions);
        if (nextConfig.providers.ollama.model) {
          setSelectedOllamaModel(nextConfig.providers.ollama.model);
        }
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setInitialLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!active || !["queued", "running"].includes(active.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api<Extraction>(`/api/extractions/${active.id}`);
        setActive(next);
        setScores(next.scores ?? {});
        if (["completed", "failed"].includes(next.status)) await loadHistory();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not refresh extraction status.");
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [active, loadHistory]);

  const chooseFile = (next: File | null) => {
    setError(null);
    if (!next) return setFile(null);
    if (!next.name.toLowerCase().endsWith(".pdf") || !["application/pdf", ""].includes(next.type)) {
      setFile(null);
      return setError("That file is not a valid PDF. Choose a PDF document.");
    }
    if (next.size > MAX_BYTES) {
      setFile(null);
      return setError("That PDF is larger than 25 MB. Choose a smaller file.");
    }
    setFile(next);
  };

  const toggleProvider = (provider: ProviderKey) => {
    if (provider === "api" && !config?.providers.api.configured) return;
    setProviders((current) =>
      current.includes(provider)
        ? current.length === 1
          ? current
          : current.filter((item) => item !== provider)
        : [...current, provider],
    );
  };

  const startExtraction = async () => {
    if (!file) return setError("Choose a PDF before starting extraction.");
    setSubmitting(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("paper", file);
      body.append("providers", JSON.stringify(providers));
      body.append("ollamaModel", selectedOllamaModel);
      const extraction = await api<Extraction>("/api/extractions", { method: "POST", body });
      setActive(extraction);
      setScores({});
      setEvaluationSaved(false);
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The extraction could not start. Check the model and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const openHistory = async (id: string) => {
    setError(null);
    try {
      const extraction = await api<Extraction>(`/api/extractions/${id}`);
      setActive(extraction);
      setScores(extraction.scores ?? {});
      setEvaluationSaved(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That saved extraction could not be opened.");
    }
  };

  const saveScores = async () => {
    if (!active) return;
    try {
      const next = await api<Extraction>(`/api/extractions/${active.id}/scores`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scores }),
      });
      setActive(next);
      setEvaluationSaved(true);
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The ratings could not be saved. Try again.");
    }
  };

  const scoreSummary = useMemo(() => {
    const values = Object.values(scores);
    if (!values.length) return null;
    const points = values.reduce((total, value) => total + (value === "correct" ? 1 : value === "partial" ? 0.5 : 0), 0);
    return Math.round((points / values.length) * 100);
  }, [scores]);

  const resultEntries = active ? (Object.entries(active.results) as Array<[ProviderKey, ProviderResult]>) : [];
  const isExtracting = active ? ["queued", "running"].includes(active.status) : false;
  const isBusy = submitting || isExtracting;
  const activePhase = phases.find(([key]) => key === active?.stage)?.[1] ?? "Preparing extraction";
  const latestEvent = active?.events.at(-1)?.message;

  const rateField = (key: string, rating: Rating) => {
    setEvaluationSaved(false);
    setScores((current) => ({ ...current, [key]: rating }));
  };

  return (
    <SkeletonTheme
      baseColor="var(--color-skeleton)"
      highlightColor="var(--color-skeleton-highlight)"
      customHighlightBackground="linear-gradient(90deg, var(--color-skeleton) 0%, var(--color-skeleton-highlight) 46%, var(--color-skeleton-highlight) 54%, var(--color-skeleton) 100%)"
      borderRadius="var(--radius-line)"
      duration={1.05}
    >
      <main className="lab-canvas">
        <h1 className="visually-hidden">RIKMS Metadata Lab</h1>

        <aside className="control-rail" aria-label="Metadata extraction controls">
          <label
            className={`upload-tile ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
            data-state={error ? "error" : file ? "success" : "default"}
            onDragEnter={() => setDragging(true)}
            onDragLeave={() => setDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              chooseFile(event.dataTransfer.files[0] ?? null);
            }}
          >
            <input
              id="paper-input"
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
            />
            <UploadIcon />
            {file ? (
              <span className="upload-copy file-copy">
                <strong>{file.name}</strong>
                <small>{formatBytes(file.size)} · click to replace</small>
              </span>
            ) : (
              <span className="upload-copy">Drop a paper here<br />or click to choose</span>
            )}
          </label>

          <section className="model-lane" aria-labelledby="model-lane-title">
            <h2 id="model-lane-title">Model Lane</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <button
                className="model-choice"
                type="button"
                aria-pressed={providers.includes("ollama")}
                onClick={() => toggleProvider("ollama")}
              >
                <span className="model-checkbox" aria-hidden="true">{providers.includes("ollama") ? "✓" : ""}</span>
                <span>Ollama (Local Lane)</span>
              </button>
              {providers.includes("ollama") && (
                <div style={{ paddingLeft: '1.75rem', display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                  <label htmlFor="ollama-model-select" style={{ fontSize: '0.75rem', fontWeight: 650, opacity: 0.85, textTransform: 'uppercase', letterSpacing: '0.02em' }}>Select Model</label>
                  <select
                    id="ollama-model-select"
                    value={selectedOllamaModel}
                    onChange={(e) => setSelectedOllamaModel(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 12px',
                      borderRadius: 'var(--radius-line)',
                      border: 'var(--rule-thin) solid var(--color-ink)',
                      background: 'var(--color-yellow)',
                      color: 'var(--color-ink)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontSize: '0.875rem',
                      fontFamily: 'inherit',
                      outline: 'none'
                    }}
                  >
                    <option value="qwen3.5:4b">qwen3.5:4b (Default)</option>
                    <option value="gemma3:4b">gemma3:4b</option>
                    <option value="gemma2:2b">gemma2:2b</option>
                    <option value="gemma2:latest">gemma2:latest</option>
                    {config?.providers.ollama.model && 
                     !["qwen3.5:4b", "gemma3:4b", "gemma2:2b", "gemma2:latest"].includes(config.providers.ollama.model) && (
                      <option value={config.providers.ollama.model}>{config.providers.ollama.model}</option>
                    )}
                  </select>
                </div>
              )}
            </div>
            <button
              className="model-choice"
              type="button"
              aria-pressed={providers.includes("api")}
              disabled={!config?.providers.api.configured}
              title={!config?.providers.api.configured ? "Add API settings to .env to enable this model." : undefined}
              onClick={() => toggleProvider("api")}
            >
              <span className="model-checkbox" aria-hidden="true">{providers.includes("api") ? "✓" : ""}</span>
              <span>{config?.providers.api.configured ? config.providers.api.model : "API (.env)"}</span>
            </button>
          </section>

          <button
            className="extract-button"
            data-state={isBusy ? "loading" : file ? "ready" : "default"}
            type="button"
            disabled={isBusy}
            onClick={() => void startExtraction()}
          >
            {isBusy ? <LoadingSpinner /> : null}
            <span>{isBusy ? "Extracting…" : "Extract Metadata"}</span>
          </button>

          {active ? (
            <div className="activity-status" role="status" aria-live="polite">
              {isBusy ? (
              <>
                <strong>{activePhase}</strong>
                <span>{latestEvent ?? "The model is preparing reviewable metadata."}</span>
                <span>{active?.progress ?? 0}% complete</span>
              </>
              ) : active.status === "completed" ? (
              <>
                <strong>Metadata ready</strong>
                {resultEntries.map(([, result]) => (
                  <span key={result.model}>
                    {result.model} (took {(result.durationMs / 1000).toFixed(1)}s)
                  </span>
                ))}
              </>
              ) : active.status === "failed" ? (
              <>
                <strong>Extraction stopped</strong>
                <span>{active.error ?? "Open the model and try again."}</span>
              </>
              ) : null}
            </div>
          ) : null}

          {error ? <div className="error-note" role="alert">{error}</div> : null}

          <section className="history-tile" aria-labelledby="history-title">
            <div className="history-heading">
              <h2 id="history-title">History</h2>
              <span>{history.length}</span>
            </div>
            <div className="history-list">
              {initialLoading ? (
                [0, 1, 2].map((item) => (
                  <div className="history-loading" key={item}>
                    <Skeleton width="78%" />
                    <Skeleton width="46%" />
                  </div>
                ))
              ) : history.length === 0 ? (
                <div className="history-empty">
                  <strong>No papers yet.</strong>
                  <span>Your completed extractions will appear here.</span>
                </div>
              ) : (
                history.map((item) => {
                  const modelsList = item.results && Object.keys(item.results).length > 0
                    ? Object.values(item.results)
                        .map((res: any) => `${res.model} (${(res.durationMs / 1000).toFixed(1)}s)`)
                        .join(" + ")
                    : item.status;
                  return (
                    <button
                      className={`history-item ${active?.id === item.id ? "is-active" : ""}`}
                      key={item.id}
                      type="button"
                      onClick={() => void openHistory(item.id)}
                    >
                      <strong>{item.fileName}</strong>
                      <span>{modelsList} · {new Date(item.createdAt).toLocaleDateString()}</span>
                    </button>
                  );
                })
              )}
            </div>
          </section>
        </aside>

        <section className="metadata-workspace" aria-label="Extracted research metadata">
          <div className="metadata-columns">
            {metadataColumns.map((fields, columnIndex) => (
              <div className="metadata-column" key={columnIndex === 0 ? "left" : "right"}>
                {fields.map((field) => (
                  <MetadataCard
                    key={field.key}
                    field={field}
                    busy={isBusy}
                    results={resultEntries}
                    scores={scores}
                    onRate={rateField}
                  />
                ))}
              </div>
            ))}
          </div>

          {resultEntries.length > 0 && !isBusy ? (
            <section className="save-ratings" aria-label="Save human validation ratings">
                <div>
                  <strong>{scoreSummary === null ? "Rate fields with the colored controls." : `Human accuracy score: ${scoreSummary}%`}</strong>
                  <span>These ratings are your validation, not the model’s confidence.</span>
                </div>
                <button
                  type="button"
                  data-state={evaluationSaved ? "success" : Object.keys(scores).length === 0 ? "disabled" : "ready"}
                  disabled={Object.keys(scores).length === 0}
                  onClick={() => void saveScores()}
                >
                  {evaluationSaved ? "Ratings saved" : "Save ratings"}
                </button>
            </section>
          ) : null}
        </section>
      </main>
    </SkeletonTheme>
  );
}
