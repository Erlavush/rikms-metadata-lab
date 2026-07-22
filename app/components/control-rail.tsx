"use client";

import type { DragEvent } from "react";
import Skeleton from "react-loading-skeleton";
import { formatBytes, humanize, latestProcessingStage, runProgressLabel } from "../metadata";
import type { Extraction, LabConfig, ProviderKey } from "../types";

type ControlRailProps = {
  config: LabConfig | null;
  history: Extraction[];
  initialLoading: boolean;
  file: File | null;
  providers: ProviderKey[];
  ollamaModel: string;
  active: Extraction | null;
  error: string | null;
  dragging: boolean;
  submitting: boolean;
  onChooseFile: (file: File | null) => void;
  onDragging: (dragging: boolean) => void;
  onToggleProvider: (provider: ProviderKey) => void;
  onSelectOllamaModel: (model: string) => void;
  onStart: () => Promise<void>;
  onOpenHistory: (id: string) => Promise<void>;
  onReprocess: () => Promise<void>;
  onDelete: () => Promise<void>;
};

export function ControlRail({
  config,
  history,
  initialLoading,
  file,
  providers,
  ollamaModel,
  active,
  error,
  dragging,
  submitting,
  onChooseFile,
  onDragging,
  onToggleProvider,
  onSelectOllamaModel,
  onStart,
  onOpenHistory,
  onReprocess,
  onDelete,
}: ControlRailProps) {
  const isExtracting = active ? ["queued", "running"].includes(active.status) : false;
  const isBusy = submitting || isExtracting;
  const latestEvent = active?.events.at(-1)?.message;
  const parsers = config?.capabilities.parsers ?? [];
  const installedModels = config?.providers.ollama.models ?? [];
  const providersReady = providers.every((provider) => provider === "ollama"
    ? Boolean(config?.providers.ollama.reachable && installedModels.includes(ollamaModel))
    : Boolean(config?.providers.api.configured));
  const canExtract = Boolean(file) && providersReady;
  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    onDragging(false);
    onChooseFile(event.dataTransfer.files[0] ?? null);
  };
  return (
    <aside className="control-rail" aria-label="Metadata extraction controls" tabIndex={0}>
      <label
        className={`upload-tile ${dragging ? "is-dragging" : ""} ${file ? "has-file" : ""}`}
        data-state={error ? "error" : file ? "success" : "default"}
        onDragEnter={() => onDragging(true)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDragging(false);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        <input id="paper-input" type="file" accept="application/pdf,.pdf" onChange={(event) => onChooseFile(event.target.files?.[0] ?? null)} />
        <span className="upload-mark" aria-hidden="true">↑</span>
        {file ? (
          <span className="upload-copy file-copy">
            <strong>{file.name}</strong>
            <small>{formatBytes(file.size)} · click to replace</small>
          </span>
        ) : (
          <span className="upload-copy">Drop a research PDF here<br />or click to choose</span>
        )}
      </label>

      <section className="model-lane" aria-labelledby="model-lane-title">
        <h2 id="model-lane-title">Model lanes</h2>
        <button className="model-choice" type="button" aria-pressed={providers.includes("ollama")} onClick={() => onToggleProvider("ollama")}>
          <span className="model-checkbox" aria-hidden="true">{providers.includes("ollama") ? "✓" : ""}</span>
          <span className="model-copy"><span>{ollamaModel || "Local model"}</span><small>{config?.providers.ollama.reachable ? "extracts + checks" : "offline"}</small></span>
        </button>
        <label className="local-model-picker">
          <span>Installed on this PC</span>
          <select
            aria-label="Local Ollama model"
            value={ollamaModel}
            disabled={isBusy || installedModels.length === 0}
            onChange={(event) => onSelectOllamaModel(event.target.value)}
          >
            {installedModels.length === 0 ? <option value="">No Ollama models found</option> : null}
            {installedModels.map((model) => <option value={model} key={model}>{model}</option>)}
          </select>
        </label>
        <button
          className="model-choice"
          type="button"
          aria-pressed={providers.includes("api")}
          disabled={!config?.providers.api.configured}
          title={!config?.providers.api.configured ? "Add API settings to .env to enable comparison." : undefined}
          onClick={() => onToggleProvider("api")}
        >
          <span className="model-checkbox" aria-hidden="true">{providers.includes("api") ? "✓" : ""}</span>
          <span className="model-copy"><span>{config?.providers.api.configured ? config.providers.api.model : "API comparison"}</span><small>{config?.providers.api.configured ? "configured" : "not configured"}</small></span>
        </button>
        <div className="capability-strip" aria-label="Available document processors">
          {parsers.map((parser) => <span key={parser.name} data-state={parser.reachable ? "ready" : "unavailable"} title={`${parser.role} · ${parser.reachable ? parser.version ?? "ready" : "unavailable"}`}>{parser.name}</span>)}
        </div>
      </section>

      <button className="extract-button" data-state={isBusy ? "loading" : canExtract ? "ready" : "default"} type="button" disabled={isBusy || !canExtract} onClick={() => void onStart()}>
        {isBusy ? <span className="button-spinner" aria-hidden="true" /> : null}
        <span>{isBusy ? "Processing…" : "Extract Metadata"}</span>
      </button>

      {active ? (
        <div className="activity-status" role="status" aria-live="polite">
          <strong>{active.status === "failed" ? `Stopped during ${humanize(latestProcessingStage(active))}` : humanize(active.stage)}</strong>
          <span>{latestEvent ?? "Preparing the document pipeline."}</span>
          <span>{runProgressLabel(active)}</span>
          {active.status === "awaiting_review" || active.status === "completed" || active.status === "failed" ? (
            <div className="run-actions">
              <button type="button" className="reprocess-button" disabled={submitting} onClick={() => void onReprocess()}>{active.status === "failed" ? "Retry with current pipeline" : "Reprocess with current pipeline"}</button>
              <button type="button" className="delete-button" disabled={submitting} onClick={() => void onDelete()}>Delete private run</button>
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? <div className="error-note" role="alert">{error}</div> : null}

      <section className="history-tile" aria-labelledby="history-title">
        <div className="history-heading"><h2 id="history-title">History</h2><span>{history.length}</span></div>
        <div className="history-list">
          {initialLoading ? ["one", "two", "three"].map((item) => (
            <div className="history-loading" key={item}><Skeleton width="78%" /><Skeleton width="46%" /></div>
          )) : history.length === 0 ? (
            <div className="history-empty"><strong>No papers yet.</strong><span>Versioned runs will appear here.</span></div>
          ) : history.map((item) => (
            <button className={`history-item ${active?.id === item.id ? "is-active" : ""}`} key={item.id} type="button" onClick={() => void onOpenHistory(item.id)}>
              <strong>{item.fileName}</strong>
              <span>{humanize(item.status)} · {new Date(item.createdAt).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
