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

const phases = [
  ["validating", "Validate PDF"],
  ["extracting_text", "Extract text"],
  ["running_models", "Run models"],
  ["validating_schema", "Validate schema"],
  ["completed", "Save result"],
] as const;

const skeletonFields = ["Title", "Authors", "Abstract"] as const;

const fieldLabels: Record<string, string> = {
  title: "Title",
  authors: "Authors",
  abstract: "Abstract",
  keywords: "Keywords",
  methodology: "Methodology",
  review_of_related_literature: "Review of related literature",
  theoretical_framework: "Theoretical framework",
  results_and_discussion: "Results and discussion",
  executive_summary: "Executive summary",
  recommendations: "Recommendations",
  doi: "DOI",
  category: "Category",
  suggested_sdgs: "Suggested SDGs",
  evidence_pages: "Evidence pages",
  overall_confidence: "Model confidence",
};

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
      : "No suggestion";
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Not found";
  if (value === null || value === undefined || value === "") return "Not found";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function PacmanIndicator() {
  return (
    <div className="pacman-indicator" aria-hidden="true">
      <span className="pacman-jaw pacman-jaw-top" />
      <span className="pacman-jaw pacman-jaw-bottom" />
      <span className="pacman-dot pacman-dot-one" />
      <span className="pacman-dot pacman-dot-two" />
      <span className="pacman-dot pacman-dot-three" />
    </div>
  );
}

export default function Home() {
  const [config, setConfig] = useState<LabConfig | null>(null);
  const [history, setHistory] = useState<Extraction[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [providers, setProviders] = useState<ProviderKey[]>(["ollama"]);
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
      return setError("Choose a genuine PDF file.");
    }
    if (next.size > MAX_BYTES) {
      setFile(null);
      return setError("PDF files may not exceed 25 MB.");
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
    if (!file) return setError("Choose a PDF first.");
    setSubmitting(true);
    setError(null);
    try {
      const body = new FormData();
      body.append("paper", file);
      body.append("providers", JSON.stringify(providers));
      const extraction = await api<Extraction>("/api/extractions", { method: "POST", body });
      setActive(extraction);
      setScores({});
      setEvaluationSaved(false);
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not start extraction.");
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
      setError(reason instanceof Error ? reason.message : "Could not open history.");
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
      setError(reason instanceof Error ? reason.message : "Could not save evaluation.");
    }
  };

  const scoreSummary = useMemo(() => {
    const values = Object.values(scores);
    if (!values.length) return null;
    const points = values.reduce((total, value) => total + (value === "correct" ? 1 : value === "partial" ? 0.5 : 0), 0);
    return Math.round((points / values.length) * 100);
  }, [scores]);

  const resultEntries = active ? (Object.entries(active.results) as Array<[ProviderKey, ProviderResult]>) : [];
  const scoreCoverage = `${Object.keys(scores).length}/${resultEntries.length * Object.keys(fieldLabels).length} fields rated`;
  const isExtracting = active ? ["queued", "running"].includes(active.status) : false;
  const activePhase = phases.find(([key]) => key === active?.stage)?.[1] ?? "Prepare extraction";

  return (
    <SkeletonTheme
      baseColor="var(--color-paper-3)"
      highlightColor="var(--color-paper-raised)"
      borderRadius="0.375rem"
      duration={1.5}
    >
    <main className="lab-shell">
      <header className="topbar">
        <div className="brand-monogram" aria-hidden="true">R</div>
        <div className="brand-copy">
          <strong>RIKMS Metadata Lab</strong>
          <span>Human-reviewed extraction workbench</span>
        </div>
        <div className="topbar-status">
          <span className="status-dot" aria-hidden="true" />
          Local system
        </div>
      </header>

      <div className="workspace">
        <aside className="history-panel" aria-label="Extraction history">
          <div className="panel-heading">
            <h2>History</h2>
            <span className="count-badge">{history.length}</span>
          </div>
          <div className="history-list">
            {initialLoading ? (
              <div className="history-skeleton" role="status" aria-label="Loading extraction history">
                {[0, 1, 2].map((item) => (
                  <div className="history-skeleton-row" key={item}>
                    <Skeleton circle width="0.5rem" height="0.5rem" />
                    <span>
                      <Skeleton width="72%" />
                      <Skeleton width="48%" />
                    </span>
                  </div>
                ))}
              </div>
            ) : history.length === 0 ? (
              <div className="empty-state">
                <p>There are no saved extractions yet.</p>
                <button type="button" onClick={() => document.getElementById("paper-input")?.click()}>
                  Choose a PDF
                </button>
              </div>
            ) : (
              history.map((item) => (
                <button
                  className={`history-item ${active?.id === item.id ? "is-active" : ""}`}
                  key={item.id}
                  onClick={() => void openHistory(item.id)}
                  type="button"
                >
                  <span className={`history-state state-${item.status}`} aria-hidden="true" />
                  <span className="history-copy">
                    <strong>{item.fileName}</strong>
                    <small>{new Date(item.createdAt).toLocaleString()}</small>
                  </span>
                  <span className="history-progress">{item.status === "completed" ? "100" : item.progress}%</span>
                </button>
              ))
            )}
          </div>
          <div className="privacy-note">
            <strong>Private local storage</strong>
            <span>PDF files and SQLite data stay in <code>.data</code>.</span>
          </div>
        </aside>

        <section className="main-stage">
          <div className="intro-row">
            <div>
              <h1>Extract. Compare. Verify.</h1>
              <p>Run a research paper through the RIKMS metadata schema, then judge every field against the source.</p>
            </div>
            <button className="new-run-button" data-state="default" type="button" onClick={() => { setActive(null); setFile(null); setScores({}); setError(null); setEvaluationSaved(false); }}>
              New extraction
            </button>
          </div>

          {error ? <div className="error-banner" role="alert">{error}</div> : null}

          <section className="upload-section" aria-labelledby="upload-title">
            <div className="section-title">
              <h2 id="upload-title">Source paper</h2>
              <p>PDF only · 25 MB maximum · SHA-256 recorded</p>
            </div>
            <label
              className={`dropzone ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
              data-state={error ? "error" : submitting ? "loading" : file ? "success" : "default"}
              onDragEnter={() => setDragging(true)}
              onDragLeave={() => setDragging(false)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                chooseFile(event.dataTransfer.files[0] ?? null);
              }}
            >
              <input id="paper-input" type="file" accept="application/pdf,.pdf" onChange={(event) => chooseFile(event.target.files?.[0] ?? null)} />
              <span className="upload-glyph" aria-hidden="true">↑</span>
              {file ? (
                <span className="file-selected">
                  <strong>{file.name}</strong>
                  <small>{formatBytes(file.size)} · ready to validate</small>
                </span>
              ) : (
                <span>
                  <strong>Drop a paper here</strong>
                  <small>or click to choose a local PDF</small>
                </span>
              )}
            </label>
          </section>

          <section className="model-section" aria-labelledby="model-title">
            <div className="section-title">
              <h2 id="model-title">Model lane</h2>
              <p>Select one model, or both for a field-by-field comparison.</p>
            </div>
            <div className="model-grid">
              <button
                className={`model-option ${providers.includes("ollama") ? "is-selected" : ""}`}
                type="button"
                aria-pressed={providers.includes("ollama")}
                data-state={providers.includes("ollama") ? "selected" : "default"}
                onClick={() => toggleProvider("ollama")}
              >
                <span className="model-radio" aria-hidden="true" />
                <span>
                  <small>Loopback Ollama</small>
                  <strong>{config ? config.providers.ollama.model : <Skeleton width="7rem" />}</strong>
                </span>
                <span className={`provider-state ${config?.providers.ollama.reachable ? "online" : "offline"}`}>
                  {config ? (config.providers.ollama.reachable ? "Ready" : "Offline") : <Skeleton width="3rem" />}
                </span>
              </button>
              <button
                className={`model-option ${providers.includes("api") ? "is-selected" : ""}`}
                type="button"
                aria-pressed={providers.includes("api")}
                aria-disabled={!config?.providers.api.configured}
                disabled={!config?.providers.api.configured}
                data-state={!config?.providers.api.configured ? "disabled" : providers.includes("api") ? "selected" : "default"}
                onClick={() => toggleProvider("api")}
              >
                <span className="model-radio" aria-hidden="true" />
                <span>
                  <small>OpenAI-compatible API</small>
                  <strong>{config ? config.providers.api.model : <Skeleton width="7rem" />}</strong>
                </span>
                <span className={`provider-state ${config?.providers.api.configured ? "online" : "offline"}`}>
                  {config ? (config.providers.api.configured ? "Configured" : ".env needed") : <Skeleton width="4rem" />}
                </span>
              </button>
            </div>
            <div className="extract-row">
              <div>
                <strong>{providers.length === 2 ? "Comparison mode" : "Single-model mode"}</strong>
                <span>The lab records processing stages, not private model reasoning.</span>
              </div>
              <button
                className="extract-button"
                data-state={submitting || isExtracting ? "loading" : !file ? "disabled" : "ready"}
                type="button"
                disabled={!file || submitting || isExtracting}
                onClick={() => void startExtraction()}
              >
                {submitting ? "Starting extraction…" : isExtracting ? "Extraction in progress" : "Extract metadata"}
              </button>
            </div>
          </section>

          {active ? (
            <section className="trace-section" aria-labelledby="trace-title">
              <div className="section-title">
                <h2 id="trace-title">Live extraction trace</h2>
                <p>{active.fileName} · {formatBytes(active.fileSize)} · {active.sha256.slice(0, 12)}…</p>
                <span className={`run-status run-${active.status}`}>{active.status}</span>
              </div>
              <div className="progress-track" aria-label={`${active.progress}% complete`}>
                <span style={{ width: `${active.progress}%` }} />
              </div>
              {isExtracting ? (
                <div className="extraction-activity" role="status" aria-live="polite">
                  <PacmanIndicator />
                  <span>
                    <strong>{activePhase}</strong>
                    <small>Qwen is preparing reviewable metadata · {active.progress}%</small>
                  </span>
                </div>
              ) : null}
              <div className="phase-grid">
                {phases.map(([key, label]) => {
                  const activeIndex = phases.findIndex(([phase]) => phase === active.stage);
                  const phaseIndex = phases.findIndex(([phase]) => phase === key);
                  const reached = active.status === "completed" || activeIndex >= phaseIndex;
                  return (
                    <div className={`phase ${reached ? "is-reached" : ""}`} key={key}>
                      <span>{reached ? "✓" : phaseIndex + 1}</span>
                      <strong>{label}</strong>
                    </div>
                  );
                })}
              </div>
              <div className="event-log" aria-live="polite">
                {active.events.slice(-5).map((event) => (
                  <div key={`${event.at}-${event.stage}`}>
                    <time>{new Date(event.at).toLocaleTimeString()}</time>
                    <span>{event.message}</span>
                  </div>
                ))}
              </div>
              {isExtracting ? (
                <div className="metadata-skeleton" role="status" aria-label="Preparing metadata fields">
                  {skeletonFields.map((label) => (
                    <div className="metadata-skeleton-row" key={label}>
                      <span>{label}</span>
                      <div>
                        <Skeleton width="46%" />
                        <Skeleton count={label === "Abstract" ? 2 : 1} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {active.error ? <div className="run-warning">{active.error}</div> : null}
            </section>
          ) : null}

          {resultEntries.length ? (
            <section className="results-section" aria-labelledby="results-title">
              <div className="results-heading">
                <div className="section-title">
                  <h2 id="results-title">Review and score</h2>
                  <p>Compare each field with the source paper before accepting it.</p>
                </div>
                <div className="score-summary">
                  <span>Human score · {scoreCoverage}</span>
                  <strong>{scoreSummary === null ? "Not scored" : `${scoreSummary}%`}</strong>
                </div>
              </div>
              <div className={`result-grid ${resultEntries.length === 2 ? "is-split" : ""}`}>
                {resultEntries.map(([provider, result]) => (
                  <article className="result-column" key={provider}>
                    <header>
                      <div>
                        <span className="result-kicker">{provider === "ollama" ? "Local model" : "API comparison"}</span>
                        <h3>{result.model}</h3>
                      </div>
                      <div className="model-metrics">
                        <span>{(result.durationMs / 1000).toFixed(1)}s</span>
                        <span>{result.inputTokens + result.outputTokens} tokens</span>
                        <span>{result.estimatedCostUsd === 0 ? "$0.0000" : "Provider billed"}</span>
                      </div>
                    </header>
                    <div className="metadata-list">
                      {Object.entries(fieldLabels).map(([field, label]) => {
                        const scoreKey = `${provider}.${field}`;
                        return (
                          <section className="metadata-field" key={field}>
                            <div className="field-heading">
                              <h4>{label}</h4>
                              <div className="rating-group" aria-label={`Rate ${label} from ${result.model}`}>
                                {(["correct", "partial", "incorrect"] as Rating[]).map((rating) => (
                                  <button
                                    className={scores[scoreKey] === rating ? `is-${rating}` : ""}
                                    key={rating}
                                    type="button"
                                    aria-pressed={scores[scoreKey] === rating}
                                    data-state={scores[scoreKey] === rating ? rating : "default"}
                                    onClick={() => {
                                      setEvaluationSaved(false);
                                      setScores((current) => ({ ...current, [scoreKey]: rating }));
                                    }}
                                  >
                                    {rating === "correct" ? "✓" : rating === "partial" ? "~" : "×"}
                                    <span>{rating}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                            <p>{formatValue(field, result.metadata[field])}</p>
                          </section>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
              <div className="save-evaluation-row">
                <p>Scores are human judgments, not model confidence.</p>
                <button
                  type="button"
                  data-state={evaluationSaved ? "success" : Object.keys(scores).length === 0 ? "disabled" : "ready"}
                  onClick={() => void saveScores()}
                  disabled={Object.keys(scores).length === 0}
                >
                  {evaluationSaved ? "Evaluation saved" : "Save evaluation"}
                </button>
              </div>
            </section>
          ) : null}

          <footer className="lab-footer">
            <span>Local only</span>
            <span>SQLite history</span>
            <span>RIKMS schema v1</span>
          </footer>
        </section>
      </div>
    </main>
    </SkeletonTheme>
  );
}
