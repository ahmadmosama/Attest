import assert from "node:assert/strict";
import test from "node:test";

import { UsageError } from "../../src/errors.mjs";
import { describeTarget, parseTarget, resolveTarget, TARGET_REFUSALS } from "../../src/config/targets.mjs";

const URL = "postgres://user:secret@db.example.test:5432/app_test?sslmode=require#frag";
const ALLOWLIST = Object.freeze([
  Object.freeze({
    host: "db.example.test",
    database: "app_test",
    nonProd: true,
    note: "local integration database"
  })
]);

function assertRefusal(fn, code, sensitive = []) {
  assert.throws(
    fn,
    (error) => {
      assert(error instanceof UsageError);
      assert.equal(error.code, code);
      const serialized = JSON.stringify(error);
      for (const value of sensitive) {
        assert.equal(serialized.includes(value), false);
        assert.equal(error.message.includes(value), false);
      }
      assert.deepEqual(Object.keys(error.details).toSorted(), ["database", "host", "port"]);
      return true;
    }
  );
}

test("parseTarget parses PostgreSQL URLs without retaining the password", () => {
  const target = parseTarget(URL);

  assert.equal(target.driver, "postgres");
  assert.equal(target.host, "db.example.test");
  assert.equal(target.port, 5432);
  assert.equal(target.database, "app_test");
  assert.equal(target.user, "user");
  assert.equal(target.password, undefined);
  assert.equal(target.raw(), URL);
  assert.equal(JSON.stringify(target).includes("secret"), false);
  assert.equal(Object.isFrozen(target), true);
});

test("parseTarget defaults postgres and postgresql URLs to port 5432", () => {
  assert.equal(parseTarget("postgres://u:p@db.example.test/app_test").port, 5432);
  assert.equal(parseTarget("postgresql://u:p@db.example.test/app_test").port, 5432);
});

test("describeTarget returns only host and database", () => {
  const target = parseTarget(URL);

  assert.equal(describeTarget(target), "db.example.test/app_test");
  assert.equal(describeTarget(target).includes("user"), false);
  assert.equal(describeTarget(target).includes("secret"), false);
  assert.equal(describeTarget(target).includes("sslmode"), false);
});

test("resolveTarget refuses targets absent from the explicit allowlist", () => {
  assertRefusal(
    () =>
      resolveTarget({
        url: URL,
        allowlist: []
      }),
    "E_DB_TARGET_NOT_ALLOWLISTED",
    ["secret", "user"]
  );
});

test("resolveTarget refuses allowlisted targets without a non production marker", () => {
  assertRefusal(
    () =>
      resolveTarget({
        url: URL,
        allowlist: [{ host: "db.example.test", database: "app_test" }]
      }),
    "E_DB_TARGET_NOT_MARKED",
    ["secret", "user"]
  );
});

test("resolveTarget refuses Supabase transaction pooler port 6543 before allowlist marker checks", () => {
  assert.throws(
    () =>
      resolveTarget({
        url: "postgres://user:secret@db.example.test:6543/app_test",
        allowlist: ALLOWLIST
      }),
    (error) => {
      assert.equal(error.code, "E_DB_POOLER_PORT");
      assert.match(error.message, /Supabase transaction pooler/);
      assert.match(error.message, /6543/);
      assert.match(error.message, /5432/);
      assert.equal(JSON.stringify(error).includes("secret"), false);
      assert.deepEqual(error.details, {
        host: "db.example.test",
        database: "app_test",
        port: 6543
      });
      return true;
    }
  );
});

test("resolveTarget refuses unsupported schemes with Phase 6 wording", () => {
  assertRefusal(
    () =>
      resolveTarget({
        url: "mysql://user:secret@db.example.test:3306/app_test",
        allowlist: ALLOWLIST
      }),
    "E_DB_TARGET_UNSUPPORTED",
    ["secret", "user"]
  );
});

test("resolveTarget refuses malformed URLs without echoing the original input", () => {
  const malformed = "postgres://user:secret@";

  assertRefusal(
    () =>
      resolveTarget({
        url: malformed,
        allowlist: ALLOWLIST
      }),
    "E_DB_TARGET_INVALID",
    ["postgres://", "secret", "user"]
  );
});

test("resolveTarget matches hosts exactly and case insensitively with no wildcard support", () => {
  assert.equal(
    describeTarget(
      resolveTarget({
        url: "postgres://user:secret@DB.EXAMPLE.TEST/app_test",
        allowlist: ALLOWLIST
      })
    ),
    "db.example.test/app_test"
  );

  assertRefusal(
    () =>
      resolveTarget({
        url: URL,
        allowlist: [{ host: "*.example.test", database: "app_test", nonProd: true, note: "too wide" }]
      }),
    "E_DB_TARGET_NOT_ALLOWLISTED",
    ["secret"]
  );
});

test("resolveTarget accepts allowlisted non production targets", () => {
  const target = resolveTarget({
    url: URL,
    allowlist: ALLOWLIST
  });

  assert.equal(describeTarget(target), "db.example.test/app_test");
});

test("TARGET_REFUSALS is the frozen refusal code list", () => {
  assert.deepEqual(TARGET_REFUSALS, [
    "E_DB_TARGET_INVALID",
    "E_DB_TARGET_UNSUPPORTED",
    "E_DB_POOLER_PORT",
    "E_DB_TARGET_NOT_ALLOWLISTED",
    "E_DB_TARGET_NOT_MARKED"
  ]);
  assert.equal(Object.isFrozen(TARGET_REFUSALS), true);
});
