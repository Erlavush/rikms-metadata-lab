import assert from "node:assert/strict";
import test from "node:test";
import { publicErrorMessage, redactEventDetails, redactPrivatePaths } from "./public-errors.js";

test("redacts private POSIX paths without hiding the actionable error", () => {
  const message = "EXDEV: cross-device link not permitted, rename '/tmp/render/page.png' -> '/home/user/lab/.data/page.png'";
  const redacted = redactPrivatePaths(message);
  assert.match(redacted, /^EXDEV: cross-device link not permitted/);
  assert.equal(redacted.includes("/tmp/"), false);
  assert.equal(redacted.includes("/home/"), false);
  assert.equal(redacted.match(/\[private path\]/g)?.length, 2);
});

test("redacts nested audit details and unknown thrown values", () => {
  assert.deepEqual(redactEventDetails({ error: "open '/home/user/private.pdf'", pages: [1] }), {
    error: "open '[private path]'",
    pages: [1],
  });
  assert.equal(publicErrorMessage("private failure"), "Unexpected server error.");
});
