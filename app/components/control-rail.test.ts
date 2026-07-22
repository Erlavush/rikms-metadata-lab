import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ControlRail } from "./control-rail.js";

const globalStyles = readFileSync(new URL("../globals.css", import.meta.url), "utf8");
const tokens = readFileSync(new URL("../../tokens.css", import.meta.url), "utf8");

test("desktop control rail is an independently scrollable viewport region", () => {
  const html = renderToStaticMarkup(createElement(ControlRail, {
    config: null,
    history: [],
    initialLoading: false,
    file: null,
    providers: ["ollama"],
    ollamaModel: "qwen3.5:4b",
    active: null,
    error: null,
    dragging: false,
    submitting: false,
    onChooseFile: () => undefined,
    onDragging: () => undefined,
    onToggleProvider: () => undefined,
    onSelectOllamaModel: () => undefined,
    onStart: async () => undefined,
    onOpenHistory: async () => undefined,
    onReprocess: async () => undefined,
    onDelete: async () => undefined,
  }));

  assert.match(html, /<aside[^>]*class="control-rail"[^>]*aria-label="Metadata extraction controls"[^>]*tabindex="0"/);
  assert.match(globalStyles, /@media \(min-width: 60rem\)[\s\S]*?\.control-rail\s*\{[^}]*position:\s*sticky[^}]*max-block-size:\s*calc\(100dvh - var\(--space-xl\) - var\(--space-lg\)\)[^}]*overflow-y:\s*auto[^}]*overscroll-behavior-y:\s*contain[^}]*scrollbar-gutter:\s*stable/);
  assert.match(globalStyles, /\.control-rail:focus-visible\s*\{[^}]*outline:\s*var\(--rule-bold\) solid var\(--color-focus\)/);
  assert.match(globalStyles, /\.control-rail > \*\s*\{[^}]*flex-shrink:\s*0/);
  assert.match(tokens, /--history-panel-height:\s*20rem/);
  assert.match(globalStyles, /@media \(min-width: 60rem\)[\s\S]*?\.history-tile\s*\{[^}]*min-height:\s*var\(--history-panel-height\)[^}]*height:\s*var\(--history-panel-height\)[^}]*max-height:\s*var\(--history-panel-height\)[^}]*flex:\s*0 0 var\(--history-panel-height\)/);
});

test("model selector renders every model reported by this PC", () => {
  const html = renderToStaticMarkup(createElement(ControlRail, {
    config: {
      maxUploadMb: 25,
      maxPages: 500,
      pipelineVersion: "2.0.4",
      schemaVersion: "2.0.2",
      parserFingerprint: "fixture",
      providers: {
        ollama: { configured: true, reachable: true, model: "qwen3.5:4b", models: ["gemma2:2b", "qwen3.5:4b", "custom-lab:7b"] },
        api: { configured: false, reachable: false, model: "Not configured" },
      },
      capabilities: { parsers: [], durableQueue: true, calibratedConfidence: false, evidenceCoordinates: true, crossrefEnabled: false },
    },
    history: [],
    initialLoading: false,
    file: null,
    providers: ["ollama"],
    ollamaModel: "qwen3.5:4b",
    active: null,
    error: null,
    dragging: false,
    submitting: false,
    onChooseFile: () => undefined,
    onDragging: () => undefined,
    onToggleProvider: () => undefined,
    onSelectOllamaModel: () => undefined,
    onStart: async () => undefined,
    onOpenHistory: async () => undefined,
    onReprocess: async () => undefined,
    onDelete: async () => undefined,
  }));

  assert.match(html, /aria-label="Local Ollama model"/);
  assert.match(html, /<option value="gemma2:2b">gemma2:2b<\/option>/);
  assert.match(html, /<option value="qwen3\.5:4b" selected="">qwen3\.5:4b<\/option>/);
  assert.match(html, /<option value="custom-lab:7b">custom-lab:7b<\/option>/);
  assert.match(html, /extracts \+ checks/);
  assert.match(globalStyles, /\.local-model-picker select\s*\{[^}]*background:\s*var\(--color-card\)[^}]*color:\s*var\(--color-ink\)[^}]*color-scheme:\s*light/);
  assert.match(globalStyles, /\.local-model-picker option\s*\{[^}]*background:\s*var\(--color-card\)[^}]*color:\s*var\(--color-ink\)/);
});
