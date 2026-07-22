"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SkeletonTheme } from "react-loading-skeleton";
import { ControlRail } from "./components/control-rail";
import { EvidenceViewer } from "./components/evidence-viewer";
import { FieldCard } from "./components/field-card";
import { RunSummary } from "./components/run-summary";
import { metadataColumns } from "./metadata";
import type { EvidenceSelection, Extraction, LabConfig, ProviderKey, Rating, ReviewAction } from "./types";

const CONFIGURED_API_URL = process.env.NEXT_PUBLIC_LAB_API_URL?.replace(/\/$/, "");

function apiUrl(): string {
  if (typeof window !== "undefined") {
    const browserHostname = window.location.hostname.replace(/^\[|\]$/g, "");
    if (CONFIGURED_API_URL) {
      try {
        const configured = new URL(CONFIGURED_API_URL);
        const configuredHostname = configured.hostname.replace(/^\[|\]$/g, "");
        const loopback = new Set(["127.0.0.1", "localhost", "::1"]);
        if (loopback.has(configuredHostname) && loopback.has(browserHostname)) {
          configured.hostname = browserHostname;
          return configured.toString().replace(/\/$/, "");
        }
      } catch {
        // The server-side request will surface an invalid explicit URL clearly.
      }
      return CONFIGURED_API_URL;
    }
    const host = browserHostname.includes(":") ? `[${browserHostname}]` : browserHostname;
    return `${window.location.protocol}//${host}:8787`;
  }
  return CONFIGURED_API_URL ?? "http://127.0.0.1:8787";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl()}${path}`, init);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() as T & { error?: string } : null;
  if (!response.ok) throw new Error(payload?.error ?? `Request failed with HTTP ${response.status}.`);
  if (!payload) throw new Error("The local API returned an unexpected response.");
  return payload;
}

export default function Home() {
  const [config, setConfig] = useState<LabConfig | null>(null);
  const [history, setHistory] = useState<Extraction[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [providers, setProviders] = useState<ProviderKey[]>(["ollama"]);
  const [ollamaModel, setOllamaModel] = useState("");
  const [active, setActive] = useState<Extraction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [evidenceSelection, setEvidenceSelection] = useState<EvidenceSelection | null>(null);

  const receiveConfig = useCallback((nextConfig: LabConfig) => {
    setConfig(nextConfig);
    setOllamaModel((current) => nextConfig.providers.ollama.models.includes(current) ? current : nextConfig.providers.ollama.model);
  }, []);

  const loadHistory = useCallback(async () => {
    const payload = await api<{ extractions: Extraction[] }>("/api/extractions?limit=40");
    setHistory(payload.extractions);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<LabConfig>("/api/config", { signal: controller.signal }),
      api<{ extractions: Extraction[] }>("/api/extractions?limit=40", { signal: controller.signal }),
    ])
      .then(([nextConfig, nextHistory]) => {
        receiveConfig(nextConfig);
        setHistory(nextHistory.extractions);
      })
      .catch((reason: Error) => {
        if (reason.name !== "AbortError") setError(reason.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setInitialLoading(false);
      });
    return () => controller.abort();
  }, [receiveConfig]);

  useEffect(() => {
    let activeRequest = true;
    const timer = window.setInterval(() => {
      void api<LabConfig>("/api/config")
        .then((nextConfig) => { if (activeRequest) receiveConfig(nextConfig); })
        .catch(() => undefined);
    }, 15_000);
    return () => {
      activeRequest = false;
      window.clearInterval(timer);
    };
  }, [receiveConfig]);

  useEffect(() => {
    if (!active || !["queued", "running"].includes(active.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api<Extraction>(`/api/extractions/${active.id}`);
        setActive(next);
        if (!["queued", "running"].includes(next.status)) await loadHistory();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not refresh extraction status.");
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [active, loadHistory]);

  useEffect(() => {
    if (!evidenceSelection) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEvidenceSelection(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [evidenceSelection]);

  const chooseFile = (next: File | null) => {
    setError(null);
    if (!next) {
      setFile(null);
      return;
    }
    if (!next.name.toLowerCase().endsWith(".pdf") || !["application/pdf", ""].includes(next.type)) {
      setFile(null);
      setError("That file is not a valid PDF. Choose a PDF document.");
      return;
    }
    const maximumBytes = (config?.maxUploadMb ?? 25) * 1024 * 1024;
    if (next.size > maximumBytes) {
      setFile(null);
      setError(`That PDF is larger than ${config?.maxUploadMb ?? 25} MB.`);
      return;
    }
    setFile(next);
  };

  const toggleProvider = (provider: ProviderKey) => {
    if (provider === "api" && !config?.providers.api.configured) return;
    setProviders((current) => current.includes(provider)
      ? current.length === 1 ? current : current.filter((item) => item !== provider)
      : [...current, provider]);
  };

  const startExtraction = async () => {
    if (!file) {
      setError("Choose a PDF before starting extraction.");
      return;
    }
    if (providers.includes("ollama") && config && (!config.providers.ollama.reachable || !config.providers.ollama.models.includes(ollamaModel))) {
      setError("No installed local Ollama model is selected. Start Ollama, install a model, or choose one from this PC.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setEvidenceSelection(null);
    try {
      const body = new FormData();
      body.append("paper", file);
      body.append("providers", JSON.stringify(providers));
      body.append("ollamaModel", ollamaModel);
      const extraction = await api<Extraction>("/api/extractions", { method: "POST", body });
      setActive(extraction);
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The extraction could not start.");
    } finally {
      setSubmitting(false);
    }
  };

  const openHistory = async (id: string) => {
    setError(null);
    setEvidenceSelection(null);
    try {
      setActive(await api<Extraction>(`/api/extractions/${id}`));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That saved extraction could not be opened.");
    }
  };

  const reprocess = async () => {
    if (!active) return;
    setSubmitting(true);
    setError(null);
    setEvidenceSelection(null);
    try {
      const next = await api<Extraction>(`/api/extractions/${active.id}/reprocess`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providers, ollamaModel }),
      });
      setActive(next);
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The document could not be reprocessed.");
    } finally {
      setSubmitting(false);
    }
  };

  const deleteExtraction = async () => {
    if (!active || !window.confirm(`Permanently delete this extraction run and its private artifacts?\n\n${active.fileName}`)) return;
    setSubmitting(true);
    setError(null);
    setEvidenceSelection(null);
    try {
      await api<{ deleted: boolean }>(`/api/extractions/${active.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      setActive(null);
      await loadHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The extraction could not be deleted.");
    } finally {
      setSubmitting(false);
    }
  };

  const saveReview = async (provider: ProviderKey, field: string, action: ReviewAction, correctedValue?: unknown) => {
    if (!active) return;
    const next = await api<Extraction>(`/api/extractions/${active.id}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, field, action, correctedValue, reviewer: "local-reviewer", notes: "" }),
    });
    setActive(next);
    setHistory((current) => current.map((item) => item.id === next.id ? next : item));
  };

  const saveRating = async (provider: ProviderKey, field: string, rating: Rating) => {
    if (!active) return;
    const next = await api<Extraction>(`/api/extractions/${active.id}/scores`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scores: { [`${provider}.${field}`]: rating } }),
    });
    setActive(next);
    setHistory((current) => current.map((item) => item.id === next.id ? next : item));
  };

  const resultEntries = active ? Object.entries(active.results) as Array<[ProviderKey, NonNullable<Extraction["results"][ProviderKey]>]> : [];
  const isBusy = submitting || Boolean(active && ["queued", "running"].includes(active.status));
  const latestActions = useMemo(() => {
    const actions: Record<string, ReviewAction> = {};
    active?.reviews.forEach((review) => { actions[`${review.provider}.${review.field}`] = review.action; });
    return actions;
  }, [active]);

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
        <ControlRail
          config={config}
          history={history}
          initialLoading={initialLoading}
          file={file}
          providers={providers}
          ollamaModel={ollamaModel}
          active={active}
          error={error}
          dragging={dragging}
          submitting={submitting}
          onChooseFile={chooseFile}
          onDragging={setDragging}
          onToggleProvider={toggleProvider}
          onSelectOllamaModel={setOllamaModel}
          onStart={startExtraction}
          onOpenHistory={openHistory}
          onReprocess={reprocess}
          onDelete={deleteExtraction}
        />
        <section className="metadata-workspace" aria-label="Extracted research metadata">
          {active ? <RunSummary extraction={active} /> : (
            <header className="workspace-intro">
              <h2>Ebidens before conpidensssss.</h2>
            </header>
          )}
          {active?.status === "failed" && resultEntries.length === 0 ? null : <div className="metadata-columns">
            {metadataColumns.map((fields, columnIndex) => (
              <div className="metadata-column" key={columnIndex === 0 ? "left" : "right"}>
                {fields.map((field) => (
                  <FieldCard
                    key={field.key}
                    field={field}
                    busy={isBusy}
                    results={resultEntries}
                    scores={active?.scores ?? {}}
                    latestActions={latestActions}
                    onRate={saveRating}
                    onReview={saveReview}
                    onEvidence={setEvidenceSelection}
                  />
                ))}
              </div>
            ))}
          </div>}
        </section>
        {active && evidenceSelection ? (
          <EvidenceViewer apiUrl={apiUrl()} extraction={active} selection={evidenceSelection} onClose={() => setEvidenceSelection(null)} />
        ) : null}
      </main>
    </SkeletonTheme>
  );
}
