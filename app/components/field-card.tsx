"use client";

import Skeleton from "react-loading-skeleton";
import { fieldResult } from "../metadata";
import type { EvidenceSelection, FieldDefinition, ProviderKey, ProviderResult, Rating, ReviewAction } from "../types";
import { ProviderField } from "./provider-field";

type FieldCardProps = {
  field: FieldDefinition;
  busy: boolean;
  results: Array<[ProviderKey, ProviderResult]>;
  scores: Record<string, Rating>;
  latestActions: Record<string, ReviewAction>;
  onRate: (provider: ProviderKey, field: string, rating: Rating) => Promise<void>;
  onReview: (provider: ProviderKey, field: string, action: ReviewAction, correctedValue?: unknown) => Promise<void>;
  onEvidence: (selection: EvidenceSelection) => void;
};

export function FieldCard({ field, busy, results, scores, latestActions, onRate, onReview, onEvidence }: FieldCardProps) {
  const hasResults = results.length > 0;
  const singleRating = results.length === 1 ? scores[`${results[0][0]}.${field.key}`] : undefined;
  return (
    <section className={`metadata-block metadata-${field.shape}${field.order > 4 ? " metadata-secondary" : ""}`} style={{ order: field.order }} aria-labelledby={`field-${field.key}`}>
      <h2 id={`field-${field.key}`}>{field.label}</h2>
      <div className={`metadata-card ${busy ? "is-loading" : !hasResults ? "is-placeholder" : "has-results"} ${hasResults && results.length > 1 ? "is-comparison" : ""}${singleRating ? ` is-${singleRating}` : ""}`} aria-busy={busy}>
        {busy ? (
          <div className="shimmer-lines" aria-hidden="true">
            {field.widths.map((width, index) => <Skeleton key={`${width}-${index}`} width={`${width}%`} height="var(--skeleton-line-height)" />)}
          </div>
        ) : hasResults ? (
          results.map(([provider, result]) => (
            <ProviderField
              key={provider}
              field={field}
              result={result}
              fieldResult={fieldResult(provider, result, field)}
              comparison={results.length > 1}
              rating={scores[`${provider}.${field.key}`]}
              latestAction={latestActions[`${provider}.${field.key}`]}
              onRate={(rating) => onRate(provider, field.key, rating)}
              onReview={(action, correctedValue) => onReview(provider, field.key, action, correctedValue)}
              onEvidence={onEvidence}
            />
          ))
        ) : (
          <div className="placeholder-lines" aria-hidden="true">
            {field.widths.map((width, index) => <span key={`${width}-${index}`} style={{ inlineSize: `${width}%` }} />)}
          </div>
        )}
      </div>
    </section>
  );
}
