import assert from "node:assert/strict";
import test from "node:test";
import { parseGrobidTei } from "./grobid.js";

test("extracts scholarly metadata from GROBID TEI", () => {
  const metadata = parseGrobidTei(`
    <TEI><teiHeader><fileDesc><titleStmt>
      <title>Water Quality in Coastal Communities</title>
    </titleStmt><sourceDesc><biblStruct><analytic>
      <author><persName><forename>Alex</forename><surname>Rivera</surname></persName></author>
      <author><persName><forename>Jordan</forename><surname>Santos</surname></persName></author>
    </analytic></biblStruct></sourceDesc></fileDesc><profileDesc><abstract><p>A field study.</p></abstract>
      <textClass><keywords><term>water</term><term>public health</term></keywords></textClass>
    </profileDesc><idno type="DOI">10.1234/example.7</idno></teiHeader>
    <text><body><div><head>Methods</head><p coords="2,10,10,20,20">Samples were tested.</p></div></body></text></TEI>
  `);
  assert.equal(metadata.title, "Water Quality in Coastal Communities");
  assert.deepEqual(metadata.authors, ["Alex Rivera", "Jordan Santos"]);
  assert.deepEqual(metadata.keywords, ["water", "public health"]);
  assert.equal(metadata.doi, "10.1234/example.7");
  assert.equal(metadata.sections[0].heading, "Methods");
});

test("does not promote a bibliography DOI to the uploaded document DOI", () => {
  const metadata = parseGrobidTei(`
    <TEI><teiHeader><fileDesc><titleStmt><title>A New Paper</title></titleStmt></fileDesc></teiHeader>
    <text><back><listBibl><biblStruct><analytic><title>An Older Citation</title></analytic>
      <idno type="DOI">10.1007/reference-only</idno>
    </biblStruct></listBibl></back></text></TEI>
  `);
  assert.equal(metadata.doi, "");
});
