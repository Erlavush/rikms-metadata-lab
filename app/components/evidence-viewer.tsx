"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";
import type { EvidenceSelection, Extraction } from "../types";

type EvidenceViewerProps = {
  apiUrl: string;
  extraction: Extraction;
  selection: EvidenceSelection;
  onClose: () => void;
};

export function EvidenceViewer({ apiUrl, extraction, selection, onClose }: EvidenceViewerProps) {
  const viewerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = viewerRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])");
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const viewer = viewerRef.current;
    viewer?.addEventListener("keydown", trapFocus);
    return () => {
      viewer?.removeEventListener("keydown", trapFocus);
      previouslyFocused?.focus();
    };
  }, []);
  const page = extraction.pages.find((item) => item.page === selection.evidence.page);
  const width = page?.width || 612;
  const height = page?.height || 792;
  const highlight = {
    left: `${Math.max(0, Math.min(100, (selection.evidence.x / width) * 100))}%`,
    top: `${Math.max(0, Math.min(100, (selection.evidence.y / height) * 100))}%`,
    width: `${Math.max(0.5, Math.min(100, (selection.evidence.width / width) * 100))}%`,
    height: `${Math.max(0.5, Math.min(100, (selection.evidence.height / height) * 100))}%`,
  };
  return (
    <aside ref={viewerRef} className="evidence-viewer" role="dialog" aria-modal="true" aria-labelledby="evidence-viewer-title">
      <div className="evidence-viewer-heading">
        <div>
          <span className="eyebrow">Source evidence</span>
          <h2 id="evidence-viewer-title">{selection.fieldLabel} · page {selection.evidence.page}</h2>
        </div>
        <button ref={closeRef} type="button" className="evidence-close" onClick={onClose} aria-label="Close evidence viewer">×</button>
      </div>
      <div className="evidence-page" style={{ aspectRatio: `${width} / ${height}` }}>
        <Image
          key={`${extraction.id}-${selection.evidence.page}`}
          src={`${apiUrl}/api/extractions/${extraction.id}/pages/${selection.evidence.page}/image`}
          alt={`Rendered source page ${selection.evidence.page}`}
          fill
          sizes="(max-width: 60rem) 94vw, 38rem"
          unoptimized
        />
        <span className="evidence-highlight" style={highlight} aria-hidden="true" />
      </div>
      <blockquote>{selection.evidence.quote}</blockquote>
      <dl className="evidence-details">
        <div><dt>Extractor</dt><dd>{selection.evidence.sourceEngine}</dd></div>
        <div><dt>Span match</dt><dd>{selection.evidence.exactMatch ? "Verified" : "Unverified"}</dd></div>
        <div><dt>Semantic check</dt><dd>{selection.evidence.semanticSupport.replaceAll("_", " ")}</dd></div>
        <div><dt>Model lane</dt><dd>{selection.model}</dd></div>
      </dl>
    </aside>
  );
}
