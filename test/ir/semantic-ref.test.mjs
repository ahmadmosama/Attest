import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../src/errors.mjs";
import { isSemanticRef, parseSemanticRef, SEMANTIC_REF_KINDS } from "../../src/ir/semantic-ref.mjs";

test("SemanticRef kinds are frozen", () => {
  assert.throws(() => SEMANTIC_REF_KINDS.push("platform"));
});

test("parseSemanticRef accepts kind:name", () => {
  assert.deepEqual(parseSemanticRef("button:place_order"), {
    kind: "button",
    name: "place_order"
  });
});

test("parseSemanticRef returns frozen objects", () => {
  const parsed = parseSemanticRef("field:email");

  assert.throws(() => {
    parsed.name = "changed";
  });
});

test("parseSemanticRef rejects selector shaped and platform shaped values", () => {
  for (const raw of ["#submit", ".btn > span", "//div[1]", "web:button"]) {
    assert.throws(
      () => parseSemanticRef(raw),
      (error) => error instanceof AttestError && error.code === "E_BAD_SEMANTIC_REF"
    );
  }
});

test("isSemanticRef reports validity without hiding unexpected errors", () => {
  assert.equal(isSemanticRef("button:place_order"), true);
  assert.equal(isSemanticRef("ios:button"), false);
});
