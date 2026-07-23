# Project Map - RIKMS-Metadata-Lab

Status: populated in Setup Mode.

## Project purpose
Local-first, provenance-first PDF metadata extraction laboratory for RIKMS research documents. It combines hybrid page-aware PDF parsing (Poppler, selective Tesseract OCR, optional Docling and GROBID), local Ollama LLM synthesis and verification, exact page coordinate evidence tracking, and field-by-field human review persistence.

## Stack
- Tags: express, javascript, nextjs, react, tailwind, typescript, vite
- Frameworks: express, nextjs, react
- Key libraries: @cloudflare/vite-plugin, @tailwindcss/postcss, @types/express, @types/multer, @types/node, @types/react, @types/react-dom, @vitejs/plugin-react, @vitejs/plugin-rsc, concurrently, dotenv, multer, zod
- Detected from: package.json, tsconfig.json

## Structure
- `app/` — React review user interface and web application
  - `app/page.tsx` — main dashboard, file upload, pipeline readiness status, and field review UI
  - `app/layout.tsx` — root layout with font imports and top-level HTML structure
  - `app/types.ts` — web UI type definitions and state representations
  - `app/metadata.ts` — field metadata descriptions and label definitions
  - `app/globals.css` — global design system styles, utility classes, and custom UI components
  - `app/components/` — React UI components for evidence viewing, field decision buttons, and status indicators
- `server/` — local Node.js Express API server and PDF metadata extraction engine
  - `server/index.ts` — Express loopback API server routes, file upload handling, and runtime capability reporting
  - `server/pipeline.ts` — background leased worker and stage orchestration
  - `server/document.ts` — hybrid PDF document loader, Poppler native text extraction, page quality scoring, and Selective OCR/Docling/GROBID routing
  - `server/fields.ts` — deterministic metadata candidate extraction, evidence coordinate matching, validation, and field-by-field retries
  - `server/extraction.ts` — Ollama local model interface, serialized execution queue, second-pass evidence verification, and VRAM memory management
  - `server/database.ts` — SQLite normalized persistence, WAL journal management, atomic queue leases, audit log, and guarded deletion
  - `server/config.ts` — environment configuration loader and lab settings validation
  - `server/version.ts` — version contracts (pipeline 2.0.9, schema 2.0.2, prompt 2.0.5, taxonomy rikms-2026.1) and fingerprint calculation
  - `server/schema.ts` — Zod metadata field validation schemas and review decision validators
  - `server/contracts.ts` — core TypeScript interface definitions for pipeline data structures
  - `server/taxonomy.ts` — research categories mapping and canonical 17 UN SDGs definitions
  - `server/calibration.ts` — empirical reliability calibration and Brier scoring
  - `server/evaluation.ts` — gold-set benchmarking and precision/recall evaluation metrics
  - `server/public-errors.ts` — public error redactor for private filesystem paths and audit details
  - `server/parsers/` — parser adapter implementations for GROBID, Docling, and Tesseract OCR
- `scripts/` — administrative setup scripts, pipeline smoke test, and evaluation tools
  - `scripts/smoke-pipeline.ts` — isolated synthetic PDF end-to-end pipeline test script
  - `scripts/evaluate.ts` — gold-set empirical evaluation runner
  - `scripts/setup-docling.sh` — Docling python venv setup script
  - `scripts/setup-grobid.sh` — GROBID service download and setup script
  - `scripts/run-grobid.sh` — GROBID service launcher script
- `tests/` — integration test suite
  - `tests/rendered-html.test.mjs` — SSR HTML server rendering test
- `worker/` — Vinext Cloudflare worker entry point
  - `worker/index.ts` — worker edge entry point for web frontend static bundle

## Relationships
- `app/page.tsx` calls `server/index.ts` via HTTP API for document upload, run status, evidence retrieval, and human review decisions.
- `server/index.ts` delegates background task execution to `server/pipeline.ts` and persists state to `server/database.ts`.
- `server/pipeline.ts` invokes `server/document.ts` to parse PDF layout and `server/fields.ts` to run metadata extraction.
- `server/fields.ts` uses `server/extraction.ts` to query local Ollama models and validate candidates against `server/schema.ts`.
- `server/document.ts` orchestrates `server/parsers/` (Poppler native, Tesseract OCR, Docling, GROBID) to construct canonical document blocks and page coordinates.
- `server/database.ts` reads contract versions and computes cache keys via `server/version.ts`.
- `scripts/smoke-pipeline.ts` instantiates `LabDatabase` and `PipelineWorker` directly for isolated end-to-end testing.

## Entry points
- `npm run dev` → `concurrently -k -n web,api,grobid -c cyan,magenta,yellow "npm:dev:web" "npm:dev:api" "npm:dev:grobid"`
- `npm run dev:core` → `concurrently -k -n web,api -c cyan,magenta "npm:dev:web" "npm:dev:api"`
- `npm run build` → `WRANGLER_LOG_PATH=.wrangler/wrangler.log vinext build`
- `npm run start` → `concurrently -k -n web,api,grobid -c cyan,magenta,yellow "WRANGLER_LOG_PATH=.wrangler/wrangler.log vinext start" "tsx server/index.ts" "bash scripts/run-grobid.sh"`
- `npm run test` → `npm run test:unit && npm run build && node --test tests/rendered-html.test.mjs`
