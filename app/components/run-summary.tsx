"use client";

import type { Extraction } from "../types";

const PAPER_STEPS = 24;

type RunSummaryProps = {
  extraction: Extraction;
};

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function extractionElapsed(extraction: Extraction): string {
  const startedAt = Date.parse(extraction.createdAt);
  const machineFinishedEvent = [...extraction.events].reverse().find((event) => event.stage === "awaiting_review" || event.stage === "failed");
  const fallbackCompletedEvent = extraction.status === "completed"
    ? [...extraction.events].reverse().find((event) => event.stage === "completed")
    : undefined;
  const endedAt = Date.parse(machineFinishedEvent?.at ?? fallbackCompletedEvent?.at ?? extraction.updatedAt);
  return formatElapsed(Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : 0);
}

function PaperGlyph({ filled, current, tone }: { filled: boolean; current: boolean; tone: number }) {
  return (
    <svg
      className="paper-progress-glyph"
      data-current={current || undefined}
      data-filled={filled || undefined}
      data-tone={tone}
      viewBox="0 0 28 34"
      aria-hidden="true"
      focusable="false"
    >
      <path className="paper-progress-sheet" d="M4 2h13l7 7v23H4z" />
      <path className="paper-progress-fold" d="M17 2v7h7" />
      <path className="paper-progress-line" d="M8 15h12M8 20h12M8 25h8" />
    </svg>
  );
}

export function RunSummary({ extraction }: RunSummaryProps) {
  const progress = Math.max(0, Math.min(100, extraction.progress));
  const filledPapers = progress === 100 ? PAPER_STEPS : Math.round((progress / 100) * PAPER_STEPS);
  const processing = extraction.status === "queued" || extraction.status === "running";
  const elapsed = extractionElapsed(extraction);
  const elapsedLabel = processing ? "Elapsed" : extraction.status === "failed" ? "Stopped after" : "Extraction time";
  const accessibleStatus = extraction.status === "failed"
    ? `Processing stopped at ${progress} percent.`
    : extraction.status === "awaiting_review"
      ? "Machine processing finished and is ready for review."
      : extraction.status === "completed"
        ? "Processing and review are complete."
        : `${progress} percent processed.`;

  return (
    <header className="paper-progress-panel" data-state={extraction.status} aria-live="polite">
      <h2 title={extraction.fileName}>{extraction.fileName}</h2>
      <div className="paper-progress-meter">
        <div
          className="paper-progress-track"
          role="progressbar"
          aria-label={`Processing ${extraction.fileName}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-valuetext={accessibleStatus}
        >
          {Array.from({ length: PAPER_STEPS }, (_, index) => (
            <PaperGlyph
              key={index}
              filled={index < filledPapers}
              current={processing && index === Math.min(filledPapers, PAPER_STEPS - 1)}
              tone={index % 4}
            />
          ))}
        </div>
        <span className="paper-progress-percent" aria-hidden="true">{progress}%</span>
        <small className="paper-progress-elapsed" aria-label={`${elapsedLabel}: ${elapsed}`}>
          {elapsedLabel} · {elapsed}
        </small>
      </div>
      <span className="visually-hidden">{accessibleStatus}</span>
    </header>
  );
}
