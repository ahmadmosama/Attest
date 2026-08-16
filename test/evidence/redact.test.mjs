import assert from "node:assert/strict";
import test from "node:test";

import { UsageError } from "../../src/errors.mjs";
import {
  createRedactor,
  DEFAULT_SECRET_HEADERS,
  DEFAULT_SECRET_QUERY_PARAMS,
  REDACTED
} from "../../src/evidence/redact.mjs";

test("redactHeaders removes Authorization values", () => {
  const redactor = createRedactor();

  assert.deepEqual(redactor.redactHeaders({ Authorization: "Bearer abc" }), {
    Authorization: REDACTED
  });
});

test("redactHeaders matches secret headers case insensitively", () => {
  const redactor = createRedactor();

  assert.deepEqual(redactor.redactHeaders({ authorization: "a" }), { authorization: REDACTED });
  assert.deepEqual(redactor.redactHeaders({ AUTHORIZATION: "b" }), { AUTHORIZATION: REDACTED });
  assert.deepEqual(redactor.redactHeaders({ Authorization: "c" }), { Authorization: REDACTED });
});

test("redactHeaders removes the default authentication header set", () => {
  const redactor = createRedactor();
  const result = redactor.redactHeaders({
    cookie: "a=1",
    "set-cookie": "b=2",
    apikey: "abc",
    "x-api-key": "def",
    "x-auth-token": "ghi",
    "proxy-authorization": "Basic secret",
    "x-csrf-token": "csrf"
  });

  assert.deepEqual(result, {
    cookie: REDACTED,
    "set-cookie": REDACTED,
    apikey: REDACTED,
    "x-api-key": REDACTED,
    "x-auth-token": REDACTED,
    "proxy-authorization": REDACTED,
    "x-csrf-token": REDACTED
  });
});

test("redactHeaders keeps headers outside the deny list", () => {
  const redactor = createRedactor();

  assert.deepEqual(redactor.redactHeaders({ accept: "application/json" }), {
    accept: "application/json"
  });
});

test("redactUrl redacts denied query parameters and leaves unrelated parameters intact", () => {
  const redactor = createRedactor();

  assert.equal(redactor.redactUrl("https://h/x?token=abc&page=2"), "https://h/x?token=[REDACTED]&page=2");
});

test("redactUrl returns a sentinel for an unparseable URL", () => {
  const redactor = createRedactor();

  assert.equal(redactor.redactUrl("not a url"), "[UNPARSEABLE_URL]");
});

test("registered secret values are replaced inside strings and nested values", () => {
  const redactor = createRedactor({ secrets: ["super-secret-token"] });

  assert.equal(redactor.redactText("prefix super-secret-token suffix"), `prefix ${REDACTED} suffix`);
  assert.deepEqual(redactor.redactValue({ nested: { value: "has super-secret-token here" } }), {
    nested: { value: `has ${REDACTED} here` }
  });
});

test("registered secret values are removed from URLs even outside denied parameters", () => {
  const redactor = createRedactor({ secrets: ["visible-secret-value"] });

  assert.equal(
    redactor.redactUrl("https://h/x?note=visible-secret-value&page=2"),
    "https://h/x?note=[REDACTED]&page=2"
  );
});

test("JWT shaped strings are redacted without registration", () => {
  const redactor = createRedactor();
  const token = "eyJabcdefgh.ijklmnopqr.stuvwxyz12";

  assert.equal(redactor.redactText(`token=${token}`), `token=${REDACTED}`);
});

test("bearer shaped strings are redacted without registration", () => {
  const redactor = createRedactor();

  assert.equal(redactor.redactText("Authorization: Bearer abcdefghijklmnop"), `Authorization: ${REDACTED}`);
});

test("redactValue returns new frozen structures and never mutates input", () => {
  const redactor = createRedactor({ secrets: ["secret-value-123"] });
  const input = {
    top: "keep",
    nested: {
      token: "secret-value-123"
    },
    list: ["secret-value-123", 4]
  };
  const original = {
    top: "keep",
    nested: {
      token: "secret-value-123"
    },
    list: ["secret-value-123", 4]
  };

  const result = redactor.redactValue(input);

  assert.notEqual(result, input);
  assert.notEqual(result.nested, input.nested);
  assert.notEqual(result.list, input.list);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.nested), true);
  assert.equal(Object.isFrozen(result.list), true);
  assert.deepEqual(input, original);
  assert.deepEqual(input, {
    top: "keep",
    nested: {
      token: "secret-value-123"
    },
    list: ["secret-value-123", 4]
  });
  assert.deepEqual(result, {
    top: "keep",
    nested: {
      token: REDACTED
    },
    list: [REDACTED, 4]
  });
});

test("createRedactor refuses empty registered secrets and ignores short values", () => {
  assert.throws(() => createRedactor({ secrets: [""] }), UsageError);

  const redactor = createRedactor({ secrets: ["short"] });
  assert.equal(redactor.redactText("short remains"), "short remains");
});

test("default deny lists are frozen lower case arrays", () => {
  assert.equal(Object.isFrozen(DEFAULT_SECRET_HEADERS), true);
  assert.equal(Object.isFrozen(DEFAULT_SECRET_QUERY_PARAMS), true);
  assert(DEFAULT_SECRET_HEADERS.every((value) => value === value.toLowerCase()));
  assert(DEFAULT_SECRET_QUERY_PARAMS.every((value) => value === value.toLowerCase()));
});

test("createRedactor returns a frozen pure transform surface", () => {
  assert.equal(Object.isFrozen(createRedactor()), true);
});
