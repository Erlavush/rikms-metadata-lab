import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadLabConfig } from "../config.js";
import { parseOcrTsv, renderPagePng } from "./ocr.js";

test("parses Tesseract TSV dimensions, words, and confidence", () => {
  const parsed = parseOcrTsv([
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "1\t1\t0\t0\t0\t0\t0\t0\t1200\t1600\t-1\t",
    "5\t1\t1\t1\t1\t1\t100\t200\t150\t30\t94.5\tMethodology",
    "5\t1\t1\t1\t1\t2\t260\t200\t120\t30\t90.0\tsection",
  ].join("\n"));
  assert.equal(parsed.imageWidth, 1200);
  assert.equal(parsed.imageHeight, 1600);
  assert.equal(parsed.words.length, 2);
  assert.equal(parsed.words[0].confidence, 94.5);
});

test("stages rendered pages on the artifact filesystem before the atomic rename", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rikms-render-test-"));
  try {
    const renderer = path.join(directory, "fake-pdftoppm.mjs");
    writeFileSync(renderer, [
      "#!/usr/bin/env node",
      'import { writeFileSync } from "node:fs";',
      "const prefix = process.argv.at(-1);",
      "if (!prefix) process.exit(2);",
      'writeFileSync(prefix + ".png", prefix);',
    ].join("\n"), { mode: 0o700 });
    chmodSync(renderer, 0o700);
    const source = path.join(directory, "source.pdf");
    writeFileSync(source, "%PDF-1.4\n%%EOF\n", { mode: 0o600 });
    const config = { ...loadLabConfig(directory), pdfRenderCommand: renderer };

    const target = await renderPagePng(source, 1, "run-one", config, 170);
    const stagingPrefix = readFileSync(target, "utf8");
    const pagesDirectory = path.dirname(target);
    assert.ok(stagingPrefix.startsWith(path.join(pagesDirectory, ".render-")));
    assert.equal(readdirSync(pagesDirectory).some((name) => name.startsWith(".render-")), false);
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
