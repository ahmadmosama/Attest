import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { REDACTED, createRedactor } from "../../../src/evidence/redact.mjs";
import { attachNetworkCollector } from "../../../src/surfaces/web/network.mjs";

class FakePage extends EventEmitter {
  off(eventName, listener) {
    this.removeListener(eventName, listener);
    return this;
  }
}

function fakeRequest({
  method = "GET",
  url = "http://example.test/",
  resourceType = "document",
  headers = Object.freeze({}),
  failure = null
} = {}) {
  return Object.freeze({
    method: () => method,
    url: () => url,
    resourceType: () => resourceType,
    headers: () => headers,
    failure: () => failure
  });
}

function fakeResponse(request, { status = 200, headers = Object.freeze({}) } = {}) {
  return Object.freeze({
    request: () => request,
    status: () => status,
    headers: () => headers
  });
}

test("network collector redacts headers, query params, and registered secrets before retaining", () => {
  const page = new FakePage();
  const secret = "registered-secret-123";
  const collector = attachNetworkCollector(page, {
    redactor: createRedactor({ secrets: [secret] })
  });
  const request = fakeRequest({
    url: `http://example.test/api?token=abc&page=2&note=${secret}`,
    resourceType: "fetch",
    headers: {
      Authorization: "Bearer abcdefghijklmnop",
      Cookie: "sid=abc",
      "x-note": `prefix ${secret} suffix`
    }
  });

  page.emit("request", request);
  page.emit(
    "response",
    fakeResponse(request, { status: 201, headers: { "content-type": "application/json" } })
  );

  const entries = collector.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, "GET");
  assert.equal(entries[0].resourceType, "fetch");
  assert.equal(entries[0].status, 201);
  assert.equal(entries[0].contentType, "application/json");
  assert.equal(entries[0].headers.authorization, REDACTED);
  assert.equal(entries[0].headers.cookie, REDACTED);
  assert.equal(entries[0].headers["x-note"], `prefix ${REDACTED} suffix`);
  assert.equal(entries[0].url, `http://example.test/api?token=${REDACTED}&page=2&note=${REDACTED}`);
  assert.equal("postData" in entries[0], false);
  assert.equal("body" in entries[0], false);
});

test("network collector records failed requests and detaches cleanly", () => {
  const page = new FakePage();
  const collector = attachNetworkCollector(page, { redactor: createRedactor() });
  const request = fakeRequest({
    url: "http://example.test/fail",
    failure: { errorText: "net::ERR_FAILED" }
  });

  page.emit("request", request);
  page.emit("requestfailed", request);
  collector.detach();
  page.emit("request", fakeRequest({ url: "http://example.test/after-detach" }));

  const entries = collector.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].failure, "net::ERR_FAILED");
  assert.equal(Number.isInteger(entries[0].startedAtMs), true);
  assert.equal(Number.isInteger(entries[0].durationMs), true);
});

test("network collector caps retained entries and records truncation", () => {
  const page = new FakePage();
  const collector = attachNetworkCollector(page, { redactor: createRedactor(), limit: 1 });

  page.emit("request", fakeRequest({ url: "http://example.test/one" }));
  page.emit("request", fakeRequest({ url: "http://example.test/two" }));

  const entries = collector.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries.truncated, 1);
  assert.equal(collector.truncated(), 1);
});
