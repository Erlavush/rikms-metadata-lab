import { readFileSync } from "node:fs";
import path from "node:path";
import { LabDatabase } from "../server/database.js";
import { evaluateExtractions, type GoldCase } from "../server/evaluation.js";

const goldPath = process.argv[2];
const databasePath = process.argv[3] ?? path.resolve(process.cwd(), process.env.LAB_DATA_DIR ?? ".data", "lab.sqlite");
if (!goldPath) throw new Error("Usage: npm run evaluate -- <gold-cases.json> [database-path]");
const payload = JSON.parse(readFileSync(path.resolve(goldPath), "utf8")) as { cases?: GoldCase[] } | GoldCase[];
const cases = Array.isArray(payload) ? payload : payload.cases ?? [];
if (!cases.length) throw new Error("The gold file contains no evaluation cases.");
const database = new LabDatabase(path.resolve(databasePath));
try {
  const extractions = new Map(cases.flatMap((gold) => {
    const extraction = database.getExtraction(gold.runId);
    return extraction ? [[gold.runId, extraction] as const] : [];
  }));
  process.stdout.write(`${JSON.stringify(evaluateExtractions(cases, extractions), null, 2)}\n`);
} finally {
  database.close();
}
