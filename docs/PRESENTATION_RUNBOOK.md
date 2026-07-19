# RIKMS Metadata Lab — Presentation Runbook

Use this file when preparing, starting, demonstrating, explaining, or troubleshooting the metadata lab. The commands below match the current repository rather than an imagined production architecture.

## The 30-second explanation

> RIKMS Metadata Lab is a separate, local-first evaluation workbench for the metadata-extraction part of RIKMS. A user uploads a PDF, the server validates and privately stores it, `pdftotext` extracts page-aware text, and Qwen 3.5 4B running through Ollama returns strict structured metadata. The output is only an AI suggestion. A human reviews each field as correct, partly correct, or incorrect, and the extraction history and ratings are saved in local SQLite. The lab cannot publish, approve, or change an official RIKMS record.

## Emergency quick start

Run these in a terminal:

```bash
cd ~/RIKMS-Metadata-Lab
git switch agent/presentation-ready-metadata-lab
git pull
npm ci
ollama list
npm run dev
```

Then open:

```text
http://localhost:3000
```

If `qwen3.5:4b` is not shown by `ollama list`, run this once:

```bash
ollama pull qwen3.5:4b
```

Press `Ctrl+C` in the terminal running the app to stop it. Do not press `Ctrl+D`: that closes the shell and may close Kitty.

## First-time setup on another computer

Requirements:

- Node.js 22.13 or newer
- `pdftotext` from Poppler
- Ollama
- Git

Clone and configure the project:

```bash
git clone https://github.com/Erlavush/rikms-metadata-lab.git
cd rikms-metadata-lab
git switch agent/presentation-ready-metadata-lab
npm ci
cp .env.example .env
```

Check the local tools:

```bash
node --version
npm --version
pdftotext -v
ollama list
```

Install the local model if needed:

```bash
ollama pull qwen3.5:4b
```

The real `.env`, uploaded PDFs, and SQLite database are intentionally ignored by Git. Never commit them.

## Normal startup and shutdown

### 1. Check Ollama

```bash
curl http://127.0.0.1:11434/api/tags
```

If that cannot connect, start Ollama in its own terminal and leave it running:

```bash
ollama serve
```

If the service is already running, Ollama may report that port `11434` is in use. That means a second server is unnecessary.

### 2. Start the lab

In another terminal:

```bash
cd ~/RIKMS-Metadata-Lab
npm run dev
```

`npm run dev` starts two processes together:

- `web`: the React/Vinext interface on `http://localhost:3000`
- `api`: the private Express API on `http://127.0.0.1:8787`

The browser should open port `3000`, not port `8787`.

### 3. Verify the backend

```bash
curl -s http://127.0.0.1:8787/api/health | python3 -m json.tool
curl -s http://127.0.0.1:8787/api/config | python3 -m json.tool
```

Expected facts:

- health says `ok: true`
- database is `sqlite`
- the Ollama model is `qwen3.5:4b`
- the local provider is reachable before the demo

### 4. Stop cleanly

Click the terminal running `npm run dev`, then press:

```text
Ctrl+C
```

The `concurrently -k` setting stops both the web and API processes together.

## What happens during one extraction

```text
Browser upload
  -> Express upload validation
  -> private .data/uploads storage + SHA-256
  -> queued SQLite record
  -> pdftotext page-aware extraction
  -> untrusted text placed inside the RIKMS prompt
  -> Qwen 3.5 4B through loopback Ollama
  -> strict JSON schema and Zod validation
  -> result and provenance saved to SQLite
  -> human field-by-field review
```

Detailed process:

1. The browser checks that the file looks like a PDF and is no larger than 25 MB.
2. The API accepts only one `.pdf`, checks its MIME type and `%PDF-` signature, sets private file permissions, records its size, and computes a SHA-256 hash.
3. The API creates a `queued` extraction record and returns immediately so the interface can show progress.
4. `pdftotext` extracts layout-preserving UTF-8 text and adds page markers. Text output is capped at 5 MB and must contain enough extractable content.
5. By default, at most the first 24,000 extracted characters are sent to the model. The document is explicitly treated as untrusted data.
6. Ollama runs `qwen3.5:4b` with temperature `0`, thinking disabled, and a strict response schema.
7. The server rejects malformed output or unsupported fields. Schema-valid output is still not automatically considered factually correct.
8. SQLite saves the model, token counts, duration, result, processing events, and any error.
9. The user validates fields with green, yellow, or red controls and explicitly saves those ratings.

The progress text is a processing trace. It is not hidden chain-of-thought and the application does not request or display private model reasoning.

## Metadata fields extracted

The schema requires these 15 fields:

1. Title
2. Authors
3. Abstract
4. Keywords
5. Methodology
6. Review of related literature
7. Theoretical framework
8. Results and discussion
9. Executive summary
10. Recommendations
11. DOI
12. Category
13. Suggested SDGs, reasons, and confidence
14. Evidence pages
15. Overall model confidence

When the paper does not support a value, the model is instructed to return an empty value rather than invent one.

## Exact live-demo sequence

Before presenting, use a synthetic or explicitly authorized text-based PDF smaller than 25 MB. Avoid a scanned image-only PDF unless the purpose is to demonstrate the honest OCR limitation.

1. Open `http://localhost:3000`.
2. Point out the upload tile, Model Lane, Extract Metadata button, History, and blank metadata cards.
3. Select the PDF.
4. Keep `qwen3.5:4b` selected. Select the API lane too only when it is configured and tested.
5. Click **Extract Metadata**.
6. Explain the visible stages: PDF validation, text reading, model extraction, schema validation, and completion.
7. Point out the circular button spinner and the moving skeletons. They indicate asynchronous work; they do not fake a result.
8. After completion, compare important fields directly with the paper: title, authors, abstract, methodology, results, and SDGs.
9. Rate each checked field:
   - green = correct
   - yellow = partly correct
   - red = incorrect
10. Explain that the selected rating also colors the card so reviewers can scan quality quickly.
11. Click **Save ratings**.
12. Open the same item from History to prove that the extraction and human evaluation were persisted.

## How the human accuracy score works

The interface assigns:

- correct = `1` point
- partly correct = `0.5` point
- incorrect = `0` points

It calculates:

```text
human accuracy score = earned points / number of rated fields x 100
```

Important reporting rules:

- Rate every expected field before calling the number an overall extraction score.
- A score from only two rated fields describes only those two fields.
- Model confidence is self-reported by the model; it is not measured accuracy.
- A serious benchmark needs multiple approved papers and a human-created ground truth.
- Schema accuracy and factual accuracy are different. Valid JSON can still contain a wrong claim.

## Optional side-by-side API comparison

Keep the real key only in `.env`:

```env
AI_API_KEY=your-real-key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=your-structured-output-model
```

Restart `npm run dev` after changing `.env`. The provider must support an OpenAI-compatible `/chat/completions` endpoint and strict `json_schema` output.

When both lanes are selected, the same extracted source text and schema are sent to both models. The interface shows the results separately so each field can be rated per provider. The API key never goes to the browser; the browser receives only availability and model name.

Do not display the `.env` file during a report and do not paste a key into a slide, terminal command, screenshot, or Git commit.

## History and database inspection

The standalone lab uses local SQLite, not Cloud SQL:

```text
.data/lab.sqlite
.data/uploads/
```

The table is named `extractions`. It stores file metadata, private file path, hash, state, provider selection, JSON results, human ratings, process events, and timestamps.

### View recent rows now, without installing `sqlite3`

Node.js on this PC includes a read-only SQLite API:

```bash
cd ~/RIKMS-Metadata-Lab
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(".data/lab.sqlite", { readOnly: true }); console.table(db.prepare("SELECT id, file_name, status, stage, progress, created_at FROM extractions ORDER BY created_at DESC LIMIT 10").all()); db.close();'
```

View the table structure:

```bash
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(".data/lab.sqlite", { readOnly: true }); console.table(db.prepare("PRAGMA table_info(extractions)").all()); db.close();'
```

Count extraction states:

```bash
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(".data/lab.sqlite", { readOnly: true }); console.table(db.prepare("SELECT status, COUNT(*) AS total FROM extractions GROUP BY status ORDER BY status").all()); db.close();'
```

### SQL shell form, if `sqlite3` is installed later

```bash
sqlite3 .data/lab.sqlite
```

Inside SQLite:

```sql
.headers on
.mode column
.tables
.schema extractions
SELECT id, file_name, status, stage, progress, created_at
FROM extractions
ORDER BY created_at DESC
LIMIT 10;
.quit
```

Use read-only `SELECT` statements during a report. Do not run `UPDATE`, `DELETE`, or edit JSON manually.

### Inspect through the local API

```bash
curl -s 'http://127.0.0.1:8787/api/extractions?limit=5' | python3 -m json.tool
```

The API deliberately does not return the private stored file path.

## Troubleshooting table

| Symptom | What it means | What to do |
|---|---|---|
| `npm: command not found` | Node/npm is unavailable | Install Node 22.13+ and reopen the terminal |
| `EADDRINUSE` on `3000` or `8787` | An old lab process is already listening | Return to its terminal and press `Ctrl+C`; inspect ports with the command below |
| Ollama shows unreachable | Port `11434` is not responding | Run `ollama serve`, then check `/api/tags` |
| Model is missing | Ollama is running but Qwen is not installed | Run `ollama pull qwen3.5:4b` |
| `Could not start pdftotext` | Poppler is missing or not on PATH | Install Poppler and verify `pdftotext -v` |
| Too little extractable text | The PDF is scanned/image-only | Use a text-based PDF; this lab does not currently perform OCR |
| HTTP 413 | The file exceeds 25 MB | Use a smaller approved PDF |
| Invalid PDF signature | The file extension says PDF but the bytes do not | Use the original valid PDF |
| Schema validation failure | The model did not obey the strict metadata contract | Retry once, inspect the model, and report the failure honestly |
| API model is disabled | `.env` lacks `AI_API_KEY` or `AI_MODEL` | Configure both and restart the lab, or demonstrate Qwen only |
| Old styling appears | Browser cache is stale | Hard-refresh the page after confirming the dev server is running |

Inspect the three local ports:

```bash
ss -ltnp | rg ':3000|:8787|:11434'
```

Inspect the API without opening the UI:

```bash
curl -i http://127.0.0.1:8787/api/health
```

If the live extraction fails, do not hide it. Open a previously completed item from History, explain the saved result, and state the exact current limitation shown by the error.

## Five-minute presentation script

### 0:00–0:40 — Purpose

> Our main RIKMS application has a broad research workflow, so I separated its metadata-extraction contract into a focused local workbench. This makes the AI behavior easier to demonstrate and gives the validation team a faster way to compare output with the source paper.

### 0:40–1:20 — Architecture

> The browser does not extract the metadata by itself. The local Express API validates and privately stores the PDF, `pdftotext` extracts page-aware text, and Ollama runs Qwen 3.5 4B. The server then validates a strict RIKMS JSON schema and saves the result and provenance to SQLite.

### 1:20–2:40 — Live extraction

Upload the prepared paper, select Qwen, and click **Extract Metadata**.

> These visible messages are real job stages, not the model's private thoughts. The document is treated as untrusted input, thinking is disabled, and the model has no database, publication, or approval tools.

### 2:40–3:50 — Output and human validation

Compare the source with several fields, then use the colored ratings.

> Green means correct, yellow means partly correct, and red means incorrect. The card changes color to make validation state easy to scan. The measured score comes from human ratings; the model's confidence is displayed separately and is not treated as accuracy.

### 3:50–4:30 — Persistence

Save ratings and reopen the extraction from History.

> SQLite preserves the extraction state, model provenance, output, and reviewer ratings. Uploaded files and the database remain below an ignored private local data directory and are never committed to Git.

### 4:30–5:00 — Honest boundary

> This lab is an evaluation and demonstration tool, not the official repository. It cannot publish, approve, authorize access, or mutate an authoritative RIKMS record. Its purpose is to make metadata quality observable and reviewable before integration decisions are made.

## Likely questions and short answers

**Does Qwen do the extraction by itself?**

Not entirely. `pdftotext` first converts the PDF to page-aware text. Qwen interprets that text and returns the structured metadata. The server validates and saves the output.

**Is 100% model confidence equal to 100% accuracy?**

No. Confidence is a model-provided estimate. Accuracy must be measured against the paper or an approved ground truth by human reviewers.

**Can the model publish or approve a paper?**

No. It returns suggestions only and has no authorization or publication tools.

**Where are papers and results stored?**

This standalone lab stores them locally under ignored `.data/`: PDF files in `.data/uploads/` and results in `.data/lab.sqlite`.

**Is this the production RIKMS database?**

No. The lab uses local SQLite. Production RIKMS uses PostgreSQL in Cloud SQL and a separate private Cloud Storage document bucket.

**Does it support scanned papers?**

Not yet. This lab reports that OCR is required when `pdftotext` finds too little text. It does not fabricate content.

**Can Team A compare two models?**

Yes. Configure an OpenAI-compatible API in `.env`, select both model lanes, and rate each provider's fields separately.

**Does the loading text show chain-of-thought?**

No. It shows controlled processing stages and safe status events only.

**What are the main current limitations?**

Text-based PDFs only, a 25 MB upload cap, the default first-24,000-character model window, no production authentication because it is a loopback lab, and human validation is still required.

## Optional: start the main RIKMS application

This is separate from the Metadata Lab. Use another terminal and another repository:

```bash
cd ~/RIKMS
composer run dev
```

Open:

```text
http://127.0.0.1:8000
```

`composer run dev` starts:

- Laravel server on port `8000`
- queue worker for the `default` and `ai` queues
- Laravel Pail live application logs
- Vite asset/HMR server on port `5173`

Port `5173` is not the RIKMS website. Press `Ctrl+C` once to stop the group.

If an old queued AI job says `AI analysis cannot start before source safety processing passes`, the queue correctly rejected that document because its source-safety gate was incomplete. It does not mean Laravel or Vite failed to start.

## Optional: safe Google Cloud inventory for the main RIKMS

These are read-only orientation commands, not deployment commands. Run them only with an authorized account and the intended project selected:

```bash
gcloud auth list
gcloud config get-value project
gcloud run services describe rikms-app --region=asia-east1 --format='yaml(metadata.name,status.url,status.latestReadyRevisionName,status.traffic)'
gcloud run revisions list --service=rikms-app --region=asia-east1 --format='table(metadata.name,status.conditions[0].status,metadata.creationTimestamp)'
gcloud sql instances list --format='table(name,databaseVersion,region,state)'
gcloud storage buckets list --format='table(name,location)'
gcloud secrets list --format='table(name)'
```

Do not run `gcloud secrets versions access`, print production environment variables, connect to production Cloud SQL to show personal account records, or list private document objects during a presentation. Explain the boundary instead: production access is role-controlled and inspection requires explicit authorization. The canonical production host is `https://rikms.v3ra.net`.

## Night-before checklist

- Pull the presentation branch.
- Run `npm ci`, `npm run lint`, and `npm test`.
- Confirm Ollama and `qwen3.5:4b` are available.
- Confirm `/api/health` and `/api/config` respond.
- Use one approved, text-based PDF below 25 MB.
- Perform one full extraction and save all field ratings.
- Keep the completed extraction in History as a fallback.
- Test the projector resolution and browser zoom.
- Close any terminal that displays secrets or private paths.
- Keep this runbook open in a separate window.
- Remember: start with `npm run dev`, open port `3000`, stop with `Ctrl+C`.
