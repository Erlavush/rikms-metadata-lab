# projectmem - RIKMS-Metadata-Lab

_Last updated: 2026-07-23_

## Project purpose
Local-first, provenance-first PDF metadata extraction laboratory for RIKMS research documents. It combines hybrid page-aware PDF parsing (Poppler, selective Tesseract OCR, optional Docling and GROBID), local Ollama LLM synthesis and verification, exact page coordinate evidence tracking, and field-by-field human review persistence.

## Recent issues
- No issues logged yet.

## Decisions
- TypeScript with native ESM modules running on Node.js >= 22.13.0 [package.json]
- Vinext web framework built on Vite with React 19, Tailwind CSS v4, and Cloudflare Vite plugin [vite.config.ts]
- Loopback Express API server on port 8787 handling file uploads, background leased worker execution, and review persistent storage [server/index.ts]
- Serialized loopback Ollama model calls (default qwen3.5:4b) for extraction, classification, and second-pass evidence verification [server/extraction.ts]
- Multi-stage page-aware native Poppler text parsing with selective Tesseract OCR fallback, optional Docling layout parsing, and optional GROBID scholarly parsing [server/document.ts]
- SQLite persistence with WAL mode, normalized schema, foreign keys, leased worker atomic queueing, and guarded deletion [server/database.ts]
- Provenance-first design requiring exact PDF coordinate evidence for every candidate field and explicit human review to reach completed status [server/fields.ts]
- Fingerprinted caching combining SHA-256 hash, pipeline version (2.0.9), schema version (2.0.2), prompt version (2.0.5), and taxonomy version (rikms-2026.1) [server/version.ts]

## Notes
- gotcha: summary.md is auto-regenerated from events.jsonl on every add_decision/add_note event — do NOT edit summary.md directly [.projectmem/summary.md]
- gotcha: Native Poppler text is preferred over layout fallbacks; route only low-quality or complex layout pages to Docling or Tesseract [server/document.ts]
- gotcha: Ollama calls are strictly serialized and resident models released before layout parsing to prevent VRAM thrashing [server/extraction.ts]
- gotcha: Document identifiers must only be accepted from GROBID TEI headers, never from bibliography entries [server/parsers/grobid.ts]
- gotcha: Render staging and final page artifacts must remain on the same filesystem to avoid cross-filesystem move errors during atomic rename [server/parsers/ocr.ts]
- gotcha: External APIs (Crossref and OpenAI comparison provider) are disabled by default to keep data local unless explicitly configured in .env [.env.example]
- lesson: Run npm run lint, npx tsc --noEmit, and npm test to verify changes before handoff; also run npm run smoke:pipeline for parser/model changes [package.json]

## Key files
- `Node.js`
- `22.13.0`
- `qwen3.5:4`
- `2.0.9`
- `2.0.2`
- `2.0.5`
- `rikms-2026.1`
- `summary.md`
- `events.jsonl`

## Open questions
- None logged yet.
