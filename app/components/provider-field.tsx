"use client";

import { useState } from "react";
import { editorValue, formatValue, humanize, parseEditorValue } from "../metadata";
import type { EvidenceSelection, FieldDefinition, FieldResult, ProviderResult, Rating, ReviewAction } from "../types";
import { MarkdownValue } from "./markdown-value";

type ProviderFieldProps = {
  field: FieldDefinition;
  result: ProviderResult;
  fieldResult: FieldResult;
  comparison: boolean;
  rating: Rating | undefined;
  latestAction: ReviewAction | undefined;
  onRate: (rating: Rating) => Promise<void>;
  onReview: (action: ReviewAction, correctedValue?: unknown) => Promise<void>;
  onEvidence: (selection: EvidenceSelection) => void;
};

const qualityRatings: Array<{ value: Rating; label: string; symbol: string }> = [
  { value: "correct", label: "Good", symbol: "✓" },
  { value: "partial", label: "Okay", symbol: "~" },
  { value: "incorrect", label: "Bad", symbol: "×" },
];

export function emptyResultMessage(status: FieldResult["status"]): string {
  if (status === "not_found") return "Not found in this document.";
  if (status === "not_applicable") return "Not applicable to this document type.";
  if (status === "failed") return "Extraction failed for this field.";
  if (status === "needs_review") return "No evidence-backed candidate survived validation.";
  return "No value available.";
}

export function ProviderField({ field, result, fieldResult, comparison, rating, latestAction, onRate, onReview, onEvidence }: ProviderFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [ratingSaving, setRatingSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formattedValue = formatValue(field.key, fieldResult.value);

  const review = async (action: ReviewAction, correctedValue?: unknown) => {
    setSaving(true);
    setError(null);
    try {
      await onReview(action, correctedValue);
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const beginEdit = () => {
    setDraft(editorValue(field.key, fieldResult.value));
    setError(null);
    setEditing(true);
  };

  const rate = async (nextRating: Rating) => {
    setRatingSaving(true);
    setError(null);
    try {
      await onRate(nextRating);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Quality rating could not be saved.");
    } finally {
      setRatingSaving(false);
    }
  };

  const saveCorrection = async () => {
    try {
      await review("correct", parseEditorValue(field.key, draft));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The corrected value is invalid.");
    }
  };

  return (
    <div className={`provider-result is-${fieldResult.status} priority-${fieldResult.reviewPriority}${rating ? ` is-${rating}` : ""}`}>
      <div className="provider-result-heading">
        {comparison ? <span className="provider-label">{result.model}</span> : null}
        <div className="field-heading-tools">
          <span className={`field-status status-${fieldResult.status}`}>{humanize(fieldResult.status)}</span>
          {fieldResult.validation.issues.length || fieldResult.error || field.key === "overall_confidence" ? (
            <details className="field-info">
              <summary aria-label={field.key === "overall_confidence" ? "About the acceptance score" : "Why this field needs attention"} title={field.key === "overall_confidence" ? "About the acceptance score" : "Why this field needs attention"}>
                <svg className="field-info-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="12" cy="6.75" r="1.75" />
                  <path d="M12 11v7" />
                </svg>
              </summary>
              <div className="field-info-panel">
                <strong>{field.key === "overall_confidence" ? "About this score" : "Needs attention"}</strong>
                <ul>
                  {fieldResult.validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
                  {fieldResult.error ? <li>{fieldResult.error}</li> : null}
                  {field.key === "overall_confidence" ? <li>Acceptance scores route fields for review. They are not factual-accuracy guarantees unless marked as calibrated.</li> : null}
                </ul>
              </div>
            </details>
          ) : null}
        </div>
      </div>
      <MarkdownValue value={formattedValue || emptyResultMessage(fieldResult.status)} />
      <div className="field-provenance" aria-label="Field provenance">
        <span>{humanize(fieldResult.method)}</span>
        <span>{Math.round(fieldResult.acceptanceScore * 100)}% {fieldResult.calibration === "calibrated" ? "calibrated confidence" : "acceptance signal"}</span>
        <span>{fieldResult.evidence.length} evidence span{fieldResult.evidence.length === 1 ? "" : "s"}</span>
      </div>
      {fieldResult.evidence.length ? (
        <div className="evidence-links" aria-label={`Evidence for ${field.label}`}>
          {fieldResult.evidence.map((evidence, index) => (
            <button
              type="button"
              key={`${evidence.blockId}-${index}`}
              onClick={() => onEvidence({ evidence, fieldLabel: field.label, model: result.model })}
            >
              Page {evidence.page}<span aria-hidden="true"> ↗</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="rating-rail" role="group" aria-label={`Rate the quality of ${field.label} from ${result.model}`}>
        {qualityRatings.map((option) => (
          <button
            className={`rating-dot rating-${option.value}`}
            type="button"
            key={option.value}
            aria-label={`${option.label} quality`}
            aria-pressed={rating === option.value}
            title={`${option.label} quality`}
            data-selected={rating === option.value}
            disabled={ratingSaving}
            onClick={() => void rate(option.value)}
          >
            <span aria-hidden="true">{option.symbol}</span>
          </button>
        ))}
      </div>
      {editing ? (
        <div className="correction-editor">
          <label htmlFor={`correction-${result.provider}-${field.key}`}>Corrected {field.label}</label>
          <textarea
            id={`correction-${result.provider}-${field.key}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={field.shape === "tall" ? 8 : 4}
          />
          <div>
            <button type="button" disabled={saving} onClick={() => void saveCorrection()}>Save correction</button>
            <button type="button" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="review-actions" aria-label={`Review ${field.label} from ${result.model}`}>
          <button type="button" data-selected={latestAction === "confirm"} disabled={saving} onClick={() => void review("confirm")}>Confirm</button>
          <button type="button" data-selected={latestAction === "correct"} disabled={saving} onClick={beginEdit}>Correct</button>
          <button type="button" data-selected={latestAction === "not_found"} disabled={saving} onClick={() => void review("not_found")}>Not found</button>
          <button type="button" data-selected={latestAction === "not_applicable"} disabled={saving} onClick={() => void review("not_applicable")}>N/A</button>
        </div>
      )}
      {error ? <span className="inline-error" role="alert">{error}</span> : null}
    </div>
  );
}
