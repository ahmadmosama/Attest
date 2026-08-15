import assert from "node:assert/strict";
import test from "node:test";

import { AttestError, InfraError, UnsupportedOpError } from "../../src/errors.mjs";
import { assertImplementsSurfacePort } from "../../src/surfaces/port.mjs";
import { createFakeSurface } from "../../src/surfaces/fake/adapter.mjs";
import { defaultScript, defineScript } from "../../src/surfaces/fake/script.mjs";

test("default fake surface implements the surface port", () => {
  const adapter = createFakeSurface(defaultScript());

  assert.doesNotThrow(() => assertImplementsSurfacePort(adapter));
  assert.equal(adapter.describeCapabilities().has("raw_escape"), true);
});

test("scripted plan ops return ok and append transcript entries", () => {
  const adapter = createFakeSurface(defaultScript());
  const session = adapter.open();

  assert.deepEqual(adapter.execute(session, { i: 4, kind: "click" }), {
    ok: true,
    detail: { i: 4, kind: "click" }
  });
  assert.deepEqual(adapter.transcript, [
    { i: 4, kind: "click", at: "fake:0", outcome: "ok" }
  ]);
});

test("unsupported capabilities throw UnsupportedOpError and record refusal", () => {
  const adapter = createFakeSurface(defaultScript());
  const session = adapter.open();

  assert.throws(
    () => adapter.execute(session, { i: 0, kind: "upload_file" }),
    (error) => error instanceof UnsupportedOpError && error.code === "E_UNSUPPORTED_OP"
  );
  assert.deepEqual(adapter.transcript, [
    { i: 0, kind: "upload_file", at: "fake:0", outcome: "unsupported" }
  ]);
});

test("fail outcomes throw AttestError instead of returning", () => {
  const adapter = createFakeSurface(
    defineScript({ byKind: { click: { outcome: "fail", message: "element not found" } } })
  );
  const session = adapter.open();

  assert.throws(
    () => adapter.execute(session, { i: 1, kind: "click" }),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_FAKE_OP_FAILED" &&
      error.message === "element not found"
  );
});

test("infra outcomes throw InfraError", () => {
  const adapter = createFakeSurface(defineScript({ byKind: { click: { outcome: "infra" } } }));
  const session = adapter.open();

  assert.throws(
    () => adapter.execute(session, { i: 2, kind: "click" }),
    (error) => error instanceof InfraError && error.code === "E_FAKE_INFRA"
  );
});

test("hang outcomes settle only when the AbortSignal fires", async () => {
  const adapter = createFakeSurface(defineScript({ byKind: { click: { outcome: "hang" } } }));
  const session = adapter.open();
  const controller = new AbortController();
  const abortError = new Error("aborted by test");
  const promise = adapter.execute(session, { i: 3, kind: "click" }, { signal: controller.signal });

  controller.abort(abortError);

  await assert.rejects(promise, abortError);
});

test("transcripts are frozen and deterministic across identical runs", () => {
  const script = defineScript({ byKind: { click: { outcome: "ok" } } });
  const first = createFakeSurface(script);
  const second = createFakeSurface(script);

  first.execute(first.open(), { i: 9, kind: "click" });
  second.execute(second.open(), { i: 9, kind: "click" });

  assert.deepEqual(first.transcript, second.transcript);
  assert.throws(() => first.transcript.push({ i: 10 }));
  assert.throws(() => {
    first.transcript[0].outcome = "fail";
  });
});

test("collectEvidence returns a deterministic null bundle reference", () => {
  const adapter = createFakeSurface(defaultScript());
  const session = adapter.open();

  assert.deepEqual(adapter.collectEvidence(session, "text", { bundle: null }), {
    kind: "text",
    path: null,
    bytes: 47
  });
});
