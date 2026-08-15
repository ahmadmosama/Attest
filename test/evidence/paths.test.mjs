import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { UsageError } from "../../src/errors.mjs";
import {
  BUNDLE_LAYOUT,
  runDirFor,
  sanitizeSegment,
  scenarioDirFor
} from "../../src/evidence/paths.mjs";

test("sanitizeSegment preserves ordinary scenario ids", () => {
  assert.equal(sanitizeSegment("checkout.guest_purchase"), "checkout.guest_purchase");
});

test("sanitizeSegment removes traversal and path separators", () => {
  const segment = sanitizeSegment("../../etc/passwd");

  assert.equal(segment.includes(".."), false);
  assert.equal(segment.includes("/"), false);
  assert.equal(segment.includes("\\"), false);
});

test("sanitizeSegment removes Windows drive letters and separators", () => {
  const segment = sanitizeSegment("C:\\Windows\\System32");

  assert.equal(segment, "Windows_System32");
  assert.equal(segment.includes(":"), false);
  assert.equal(segment.includes("\\"), false);
});

test("sanitizeSegment escapes Windows reserved device names", () => {
  assert.equal(sanitizeSegment("CON"), "_CON");
  assert.equal(sanitizeSegment("nul"), "_nul");
});

test("sanitizeSegment rejects empty segments", () => {
  for (const input of ["", "///"]) {
    assert.throws(
      () => sanitizeSegment(input),
      (error) => error instanceof UsageError && error.code === "E_BAD_PATH_SEGMENT"
    );
  }
});

test("sanitizeSegment truncates long segments with a stable hash suffix", () => {
  const input = "a".repeat(140);
  const segment = sanitizeSegment(input);

  assert.equal(segment.length, 100);
  assert.match(segment, /^[a]+-[a-f0-9]{6}$/);
  assert.equal(segment, sanitizeSegment(input));
});

test("path helpers use the fixed layout contract", () => {
  const root = path.join("artifacts");
  const runDir = runDirFor(root, "20260815T044612Z-9f3a1c07");

  assert.equal(runDir, path.join(root, "20260815T044612Z-9f3a1c07"));
  assert.equal(
    scenarioDirFor(runDir, "checkout.guest_purchase", "web"),
    path.join(runDir, BUNDLE_LAYOUT.scenarios, "checkout.guest_purchase__web")
  );
});
