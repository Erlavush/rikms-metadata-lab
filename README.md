# RIKMS Metadata Lab

A local-first workbench for demonstrating and evaluating the metadata extraction contract used by RIKMS. It accepts private PDF research papers, extracts page-aware text with `pdftotext`, asks one or two configured models for strict structured metadata, validates the response, and saves human scoring to SQLite.

The lab does **not** publish, approve, or mutate authoritative RIKMS records. Model output is always a suggestion for human review.

## What it includes

- PDF upload with a 25 MB limit, signature check, SHA-256 provenance, and private storage
- Canonical RIKMS metadata prompt, JSON schema, field limits, and SDG validation
- Local Ollama support with `qwen3.5:4b` as the default model
- Optional OpenAI-compatible API model for side-by-side comparison
- Honest live stages without requesting or displaying hidden chain-of-thought
- Adaptive skeleton placeholders while history, providers, and metadata fields load
- A compact Pac-Man activity indicator during queued and running extraction jobs
- Field-by-field human scoring: correct, partial, or incorrect
- SQLite extraction history and model provenance
- API keys, PDF files, and SQLite data excluded from Git

## Requirements

- Node.js 22.13 or newer (Node.js 24 recommended)
- `pdftotext` from Poppler
- Ollama and the chosen local model for the local lane

Confirm the local tools:

```bash
node --version
pdftotext -v
ollama list
```

Install the default model when needed:

```bash
ollama pull qwen3.5:4b
```

## Start locally

```bash
git clone https://github.com/Erlavush/rikms-metadata-lab.git
cd rikms-metadata-lab
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:3000`. The private API listens only on `http://127.0.0.1:8787`.

`npm run dev` starts both the interface and the loopback API. Press `Ctrl+C` once to stop both.

## Optional comparison API

Put secrets only in the ignored `.env` file:

```env
AI_API_KEY=your-key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=your-structured-output-model
```

The comparison provider must support the OpenAI-compatible `/chat/completions` endpoint and strict `json_schema` response format. The browser receives only the configured model name and availability state, never the API key.

## Private storage

Local state is stored below ignored `.data/`:

```text
.data/
├── lab.sqlite
└── uploads/
```

PDF bytes are stored as private files. SQLite stores file metadata, hashes, processing stages, provider results, and human evaluations. Do not commit or share `.data/`.

## Validation

```bash
npm test
npm run lint
npm audit
```

Use synthetic or explicitly authorized research papers for demonstrations and accuracy testing.

## Loading interface credits

Skeleton placeholders use [`react-loading-skeleton`](https://github.com/dvtng/react-loading-skeleton). The web-native Pac-Man animation is inspired by type 26 from [`NVActivityIndicatorView`](https://github.com/ninjaprox/NVActivityIndicatorView); the original package targets Swift/UIKit, so this project uses a small CSS implementation instead of adding an incompatible iOS dependency.
