import assert from "node:assert/strict";
import test from "node:test";
import { parseDoclingJson } from "./docling.js";

test("normalizes Docling JSON into page-coordinate blocks", () => {
  const blocks = parseDoclingJson({
    pages: { "1": { page_no: 1, size: { width: 612, height: 792 } } },
    texts: [
      { self_ref: "#/texts/0", label: "section_header", text: "Methodology", prov: [{ page_no: 1, bbox: { l: 72, t: 700, r: 200, b: 680, coord_origin: "BOTTOMLEFT" } }] },
      { self_ref: "#/texts/1", label: "text", text: "A reproducible survey was used.", prov: [{ page_no: 1, bbox: { l: 72, t: 670, r: 400, b: 640, coord_origin: "BOTTOMLEFT" } }] },
    ],
  });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "heading");
  assert.deepEqual(blocks[1].sectionPath, ["Methodology"]);
  assert.equal(blocks[0].y, 92);
});
