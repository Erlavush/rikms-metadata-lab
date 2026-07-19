import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  analysisInstruction,
  rikmsMetadataValidator,
  rikmsResponseSchema,
  systemInstruction,
  type RikmsMetadata,
} from "./schema.js";

export type ProviderKey = "ollama" | "api";

export type ProviderResult = {
  provider: ProviderKey;
  model: string;
  metadata: RikmsMetadata;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  estimatedCostUsd: number | null;
};

export type LabConfig = {
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaNumCtx: number;
  ollamaMaxInputCharacters: number;
  ollamaKeepAlive: string;
  apiBaseUrl: string;
  apiModel: string;
  apiKey: string;
  timeoutMs: number;
  pdfTextCommand: string;
};

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function loopbackBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname) ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Ollama must use an absolute loopback-only URL without credentials or a path.");
  }
  return value.replace(/\/$/, "");
}

function apiBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
    throw new Error("The comparison API must use HTTPS, or HTTP only on loopback, without credentials in the URL.");
  }
  return value.replace(/\/$/, "");
}

export function loadLabConfig(): LabConfig {
  return {
    ollamaBaseUrl: loopbackBaseUrl(process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"),
    ollamaModel: (process.env.OLLAMA_MODEL ?? "qwen3.5:4b").trim(),
    ollamaNumCtx: boundedInteger(process.env.OLLAMA_NUM_CTX, 8192, 2048, 32768),
    ollamaMaxInputCharacters: boundedInteger(process.env.OLLAMA_MAX_INPUT_CHARACTERS, 24000, 1000, 120000),
    ollamaKeepAlive: (process.env.OLLAMA_KEEP_ALIVE ?? "30m").trim(),
    apiBaseUrl: apiBaseUrl(process.env.AI_BASE_URL ?? "https://api.openai.com/v1"),
    apiModel: (process.env.AI_MODEL ?? "").trim(),
    apiKey: (process.env.AI_API_KEY ?? "").trim(),
    timeoutMs: boundedInteger(process.env.AI_TIMEOUT_SECONDS, 180, 10, 600) * 1000,
    pdfTextCommand: (process.env.PDFTOTEXT_COMMAND ?? "pdftotext").trim(),
  };
}

function normalize(text: string): string {
  return text
    .replaceAll("\0", "")
    .replace(/[ \t]+/g, " ")
    .replace(/\r?\n{3,}/g, "\n\n")
    .trim();
}

export async function extractPdfText(filePath: string, command: string, timeoutMs: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const process = spawn(command, ["-layout", "-enc", "UTF-8", filePath, "-"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
    };

    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      finish(new Error("PDF text extraction exceeded its time limit."));
    }, timeoutMs);

    process.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 5_000_000) {
        process.kill("SIGKILL");
        finish(new Error("Extracted PDF text exceeded the 5 MB safety limit."));
        return;
      }
      output.push(chunk);
    });
    process.stderr.on("data", (chunk: Buffer) => {
      if (errors.reduce((total, item) => total + item.length, 0) < 32_000) errors.push(chunk);
    });
    process.on("error", (error) => finish(new Error(`Could not start pdftotext: ${error.message}`)));
    process.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`pdftotext failed${errors.length ? `: ${Buffer.concat(errors).toString("utf8").trim()}` : "."}`));
        return;
      }
      clearTimeout(timer);
      settled = true;
      const pages = Buffer.concat(output)
        .toString("utf8")
        .split("\f")
        .map(normalize)
        .filter(Boolean);
      const marked = pages.map((page, index) => `--- PAGE ${index + 1} ---\n${page}`).join("\n\n");
      if (normalize(marked).length < 500) {
        reject(new Error("The PDF contains too little extractable text. A scanned PDF requires OCR before analysis."));
        return;
      }
      resolve(marked);
    });
  });
}

function documentPrompt(text: string, maximumCharacters: number): string {
  return `${analysisInstruction}\n\nUNTRUSTED DOCUMENT START\n${text.slice(0, maximumCharacters)}\nUNTRUSTED DOCUMENT END`;
}

function parseMetadata(content: unknown): RikmsMetadata {
  const decoded = typeof content === "string" ? JSON.parse(content) : content;
  return rikmsMetadataValidator.parse(decoded);
}

export async function runOllama(text: string, config: LabConfig): Promise<ProviderResult> {
  const started = performance.now();
  const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(config.timeoutMs),
    body: JSON.stringify({
      model: config.ollamaModel,
      stream: false,
      think: false,
      keep_alive: config.ollamaKeepAlive,
      format: rikmsResponseSchema,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: documentPrompt(text, config.ollamaMaxInputCharacters) },
      ],
      options: { temperature: 0, num_ctx: config.ollamaNumCtx, num_predict: 8192 },
    }),
  });
  if (!response.ok) throw new Error(`Ollama request failed with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    message?: { content?: unknown };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  return {
    provider: "ollama",
    model: config.ollamaModel,
    metadata: parseMetadata(payload.message?.content),
    inputTokens: payload.prompt_eval_count ?? 0,
    outputTokens: payload.eval_count ?? 0,
    durationMs: Math.round(performance.now() - started),
    estimatedCostUsd: 0,
  };
}

export async function runApiModel(text: string, config: LabConfig): Promise<ProviderResult> {
  if (!config.apiKey || !config.apiModel) throw new Error("The comparison API is not configured in .env.");
  const started = performance.now();
  const response = await fetch(`${config.apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    signal: AbortSignal.timeout(config.timeoutMs),
    body: JSON.stringify({
      model: config.apiModel,
      temperature: 0,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: documentPrompt(text, config.ollamaMaxInputCharacters) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "rikms_metadata", strict: true, schema: rikmsResponseSchema },
      },
    }),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Comparison API failed with HTTP ${response.status}${body ? `: ${body}` : "."}`);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    provider: "api",
    model: config.apiModel,
    metadata: parseMetadata(payload.choices?.[0]?.message?.content),
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    outputTokens: payload.usage?.completion_tokens ?? 0,
    durationMs: Math.round(performance.now() - started),
    estimatedCostUsd: null,
  };
}
