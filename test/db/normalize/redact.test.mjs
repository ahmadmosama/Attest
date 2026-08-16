import assert from "node:assert/strict";
import test from "node:test";

import { AttestError } from "../../../src/errors.mjs";
import { REDACTED } from "../../../src/evidence/redact.mjs";
import { createRowRedactor, REDACTION_MODES } from "../../../src/db/normalize/redact.mjs";

test("declared sensitive columns are hashed with stable short digests", () => {
  const redactor = createRowRedactor({ sensitive: ["public.users.email"] });

  const first = redactor.redactRow("public.users", { id: 1, email: "a@example.com" });
  const second = redactor.redactRow("public.users", { id: 2, email: "a@example.com" });
  const changed = redactor.redactRow("public.users", { id: 3, email: "b@example.com" });

  assert.match(first.email, /^sha256:[0-9a-f]{12}$/);
  assert.equal(first.email, second.email);
  assert.notEqual(first.email, changed.email);
  assert.deepEqual(Object.keys(first), ["id", "email"]);
});

test("column wildcard entries match the named column on every entity", () => {
  const redactor = createRowRedactor({ sensitive: ["*.password_hash"] });

  assert.match(redactor.redactRow("public.users", { password_hash: "abc" }).password_hash, /^sha256:/);
  assert.match(redactor.redactRow("admin.accounts", { password_hash: "abc" }).password_hash, /^sha256:/);
});

test("database wide wildcard policies are refused by name", () => {
  assert.throws(
    () => createRowRedactor({ sensitive: ["*.*"] }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_REDACTION_POLICY_INVALID" &&
      error.details.entry === "*.*"
  );
});

test("mask mode replaces declared values without a digest", () => {
  const redactor = createRowRedactor({
    sensitive: ["public.users.email"],
    mode: "mask"
  });

  assert.equal(redactor.redactRow("public.users", { email: "a@example.com" }).email, REDACTED);
});

test("token shaped values in undeclared columns use the shared redactor", () => {
  const redactor = createRowRedactor();
  const jwt = "eyJabcdefgh.ijklmnopqr.stuvwxyz12";

  assert.deepEqual(redactor.redactRow("public.audit", { note: `token=${jwt}` }), {
    note: `token=${REDACTED}`
  });
  assert.deepEqual(redactor.redactRow("public.audit", { note: "Authorization: Bearer abcdefghijklmnop" }), {
    note: `Authorization: ${REDACTED}`
  });
});

test("registered secrets are redacted inside nested values", () => {
  const redactor = createRowRedactor({ secrets: ["super-secret-token"] });

  assert.deepEqual(redactor.redactRow("public.audit", { payload: { value: "super-secret-token" } }), {
    payload: { value: REDACTED }
  });
});

test("redaction preserves row keys and is idempotent", () => {
  const redactor = createRowRedactor({
    sensitive: ["public.users.email"],
    secrets: ["super-secret-token"]
  });
  const once = redactor.redactRow("public.users", {
    id: 1,
    email: "a@example.com",
    note: "super-secret-token"
  });
  const twice = redactor.redactRow("public.users", once);

  assert.deepEqual(Object.keys(once), ["id", "email", "note"]);
  assert.deepEqual(twice, once);
});

test("invalid modes and policy shape are rejected", () => {
  assert.equal(Object.isFrozen(REDACTION_MODES), true);
  assert.throws(
    () => createRowRedactor({ mode: "drop" }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_REDACTION_POLICY_INVALID" &&
      error.details.field === "mode"
  );
  assert.throws(
    () => createRowRedactor({ sensitive: ["public.*.email"] }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_REDACTION_POLICY_INVALID" &&
      error.details.entry === "public.*.email"
  );
  assert.throws(
    () => createRowRedactor({ sensitive: ["users.email"] }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_REDACTION_POLICY_INVALID" &&
      error.details.entry === "users.email"
  );
});

test("describePolicy returns a frozen sorted policy surface", () => {
  const redactor = createRowRedactor({
    sensitive: ["public.users.email", "*.password_hash"],
    mode: "mask"
  });

  const policy = redactor.describePolicy();

  assert.equal(Object.isFrozen(redactor), true);
  assert.equal(Object.isFrozen(policy), true);
  assert.deepEqual(policy, {
    mode: "mask",
    sensitive: ["*.password_hash", "public.users.email"]
  });
});
