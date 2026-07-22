import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(projectRoot, ".tools", "grobid-0.9.0", "grobid-home", "config", "grobid.yaml");
let config = readFileSync(configPath, "utf8");
config = config.replace(/(\n\s*concurrency:)\s*\d+/, "$1 2");
for (const port of [8070, 8071]) {
  const unsecured = new RegExp(`(\\n\\s*port: ${port})(?!\\n\\s*bindHost:)`);
  config = config.replace(unsecured, `$1\n      bindHost: 127.0.0.1`);
}
if (!config.includes("port: 8070\n      bindHost: 127.0.0.1") || !config.includes("port: 8071\n      bindHost: 127.0.0.1")) {
  throw new Error("Could not enforce loopback-only GROBID connectors.");
}
writeFileSync(configPath, config, { encoding: "utf8", mode: 0o600 });
