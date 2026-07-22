import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);

async function render() {
  const url = new URL(workerUrl);
  url.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(url.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the RIKMS Metadata Lab", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>RIKMS Metadata Lab<\/title>/i);
  assert.match(html, /RIKMS Metadata Lab/);
  assert.match(html, /Model lanes/i);
  assert.match(html, /Ebidens before conpidensssss\./i);
  assert.doesNotMatch(html, /RIKMS Metadata Lab · pipeline 2|Upload an authorized research PDF/i);
  assert.match(html, /Extract Metadata/);
  assert.match(html, /Related Literature/);
  assert.match(html, /Lilita One/);
  assert.match(html, /Fredoka/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview|Your site is taking shape/i);
});
