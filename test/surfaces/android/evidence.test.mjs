import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, test } from "node:test";

import { createAndroidSurface } from "../../../src/surfaces/android/adapter.mjs";
import { MAX_RECORD_SECONDS } from "../../../src/surfaces/android/evidence.mjs";
import { createFakeAdb, fakeDeviceLease, DEFAULT_HIERARCHY } from "../../helpers/fake-adb.mjs";

const SECRET = "sk_live_attest_fake_token_value";

function memoryBundle() {
  const written = new Map();

  return Object.freeze({
    dir: null,
    write(relPath, data) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      written.set(relPath, bytes);
      return Object.freeze({ kind: relPath, path: relPath, bytes: bytes.byteLength });
    },
    written() {
      return written;
    }
  });
}

function context(bundle) {
  return Object.freeze({
    runId: "android-evidence",
    scenarioId: "android.evidence",
    surface: "android",
    bundle,
    timeouts: Object.freeze({ stepMs: 400 }),
    now: () => new Date("2026-08-17T00:00:00.000Z")
  });
}

function surface({ adb, secrets = [], record = true }) {
  return createAndroidSurface({
    lease: fakeDeviceLease(),
    packageName: "attest.selfverify",
    activity: ".MainActivity",
    secrets,
    record,
    deps: { runAdb: adb.runAdb, startAdb: adb.startAdb }
  });
}

describe("android evidence capture", () => {
  test("a checkpoint writes a screenshot named for the step and the label", async () => {
    const adb = createFakeAdb();
    const bundle = memoryBundle();
    const adapter = surface({ adb });
    const session = await adapter.open(context(bundle));

    const result = await adapter.execute(session, { i: 4, kind: "checkpoint", label: "after create" });
    await adapter.close(session);

    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].path, "evidence/step-4-checkpoint-after_create.png");
    assert(result.evidence[0].bytes > 0);
    assert(bundle.written().has("evidence/step-4-checkpoint-after_create.png"));
  });

  test("failure evidence carries the screenshot and the hierarchy of the failing step", async () => {
    const adb = createFakeAdb();
    const bundle = memoryBundle();
    const adapter = surface({ adb });
    const session = await adapter.open(context(bundle));

    const reference = await adapter.collectEvidence(session, "failure", { bundle });
    await adapter.close(session);

    assert.equal(reference.path, "evidence/failure.png");
    assert(reference.bytes > 0);
    // Without the tree, "the locator did not resolve" is unfalsifiable.
    assert(bundle.written().has("evidence/failure-hierarchy.xml"));
    assert.match(bundle.written().get("evidence/failure-hierarchy.xml").toString("utf8"), /customer_list/u);
  });

  test("evidence for any other kind is nothing, not an empty artifact", async () => {
    const adb = createFakeAdb();
    const adapter = surface({ adb });
    const session = await adapter.open(context(memoryBundle()));

    assert.equal(await adapter.collectEvidence(session, "checkpoint"), null);
    await adapter.close(session);
  });

  test("the hierarchy dump is redacted before it reaches disk", async () => {
    const adb = createFakeAdb({
      hierarchy: DEFAULT_HIERARCHY.replace('text="2 customers"', `text="token ${SECRET}"`)
    });
    const bundle = memoryBundle();
    const adapter = surface({ adb, secrets: [SECRET] });
    const session = await adapter.open(context(bundle));

    await adapter.collectEvidence(session, "failure", { bundle });
    await adapter.close(session);

    const xml = bundle.written().get("evidence/failure-hierarchy.xml").toString("utf8");
    // The dump carries whatever text the app rendered, so redaction happens at
    // capture time exactly as the web HAR is redacted at capture time.
    assert.doesNotMatch(xml, new RegExp(SECRET, "u"));
    assert.match(xml, /REDACTED/u);
  });

  test("a failed scenario retains the recording and a passing one discards it", async () => {
    const failing = createFakeAdb();
    const failedBundle = memoryBundle();
    const failedAdapter = surface({ adb: failing });
    const failedSession = await failedAdapter.open(context(failedBundle));
    await failedAdapter.collectEvidence(failedSession, "failure", { bundle: failedBundle });
    await failedAdapter.close(failedSession);

    assert(failedBundle.written().has("evidence/recording.mp4"));

    const passing = createFakeAdb();
    const passedBundle = memoryBundle();
    const passedAdapter = surface({ adb: passing });
    const passedSession = await passedAdapter.open(context(passedBundle));
    await passedAdapter.close(passedSession);

    assert.equal(passedBundle.written().has("evidence/recording.mp4"), false);
  });

  test("recording is started at open with the device ceiling, not after a failure", async () => {
    const adb = createFakeAdb();
    const adapter = surface({ adb });
    const session = await adapter.open(context(memoryBundle()));
    await adapter.close(session);

    const start = adb.transcript().find((entry) => entry.args.includes("screenrecord"));
    assert(start !== undefined, "recording must start at open, a recording that starts after the failure missed it");
    assert(start.args.includes("--time-limit"));
    assert(start.args.includes(String(MAX_RECORD_SECONDS)));
  });

  test("both the recording and the dump are removed from the device on close", async () => {
    const adb = createFakeAdb();
    const bundle = memoryBundle();
    const adapter = surface({ adb });
    const session = await adapter.open(context(bundle));

    await adapter.execute(session, { i: 0, kind: "expect_visible", locator: { strategy: "testId", value: "customer_list" } });
    await adapter.collectEvidence(session, "failure", { bundle });
    await adapter.close(session);

    assert.deepEqual([...adb.deviceFiles().keys()], []);
  });

  test("recording can be turned off entirely", async () => {
    const adb = createFakeAdb();
    const bundle = memoryBundle();
    const adapter = surface({ adb, record: false });
    const session = await adapter.open(context(bundle));
    await adapter.collectEvidence(session, "failure", { bundle });
    await adapter.close(session);

    assert.equal(adb.transcript().some((entry) => entry.args.includes("screenrecord")), false);
    assert.equal(bundle.written().has("evidence/recording.mp4"), false);
  });

  test("a capture failure returns null rather than replacing the scenario result", async () => {
    const adb = createFakeAdb({ failCommands: ["-s emulator-5554 exec-out screencap -p"] });
    const bundle = memoryBundle();
    const adapter = surface({ adb });
    const session = await adapter.open(context(bundle));

    const reference = await adapter.collectEvidence(session, "failure", { bundle });
    await adapter.close(session);

    assert.equal(reference, null);
    // The hierarchy still landed. One failed capture must not cost the others.
    assert(bundle.written().has("evidence/failure-hierarchy.xml"));
  });
});
