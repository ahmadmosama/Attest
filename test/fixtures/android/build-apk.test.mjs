import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import {
  BuildError,
  buildFixtureApk,
  DEFAULT_JDK_CANDIDATES,
  resolveSdk,
  resolveToolchain
} from "../../../tools/build-fixture-apk.mjs";

const SOURCE_DIR = path.join("fixtures", "self-verify", "android");
const OUT = path.join(".attest", "fixture-test", "attest-selfverify.apk");
const BUILD_TIMEOUT_MS = 300000;

function sdkAvailable() {
  try {
    resolveSdk();
    return true;
  } catch {
    return false;
  }
}

describe("android fixture apk build", () => {
  test("the fixture source declares ids, a deeplink filter and cleartext to the loopback alias", async () => {
    const manifest = await readFile(path.join(SOURCE_DIR, "AndroidManifest.xml"), "utf8");
    const ids = await readFile(path.join(SOURCE_DIR, "res", "values", "ids.xml"), "utf8");

    assert.match(manifest, /package="attest\.selfverify"/u);
    assert.match(manifest, /android:usesCleartextTraffic="true"/u);
    assert.match(manifest, /android:scheme="attest-selfverify"/u);
    assert.match(manifest, /android\.permission\.INTERNET/u);

    // uiautomator reports resource-id from the resource name, so declared ids
    // are what let the android bindings address this app by id at all.
    for (const id of ["customer_list", "create_order_action", "delete_customer_action", "status_text"]) {
      assert.match(ids, new RegExp(`name="${id}"`, "u"));
    }
  });

  test("the android bindings bind the same refs the web bindings do", async () => {
    const android = await readFile(
      path.join("fixtures", "self-verify", "bindings", "selfverify", "android.yaml"),
      "utf8"
    );

    assert.match(android, /^surface: android$/mu);
    assert.match(android, /button:create_order/u);
    assert.match(android, /button:delete_customer/u);
    assert.match(android, /deeplink: "attest-selfverify:\/\/customers"/u);
  });

  test("a missing SDK is refused by name with the env var that fixes it", () => {
    assert.throws(
      () => resolveSdk({}),
      (error) => {
        assert(error instanceof BuildError);
        assert.equal(error.code, "E_SDK_NOT_FOUND");
        assert.match(error.details.remediation, /ANDROID_HOME/u);
        return true;
      }
    );
  });

  test("a missing JDK is refused by name rather than falling back to PATH", async (t) => {
    if (!sdkAvailable()) {
      t.skip("no Android SDK on this machine, so there is no toolchain to resolve against");
      return;
    }

    // ENV-VERIFIED records that java is not on PATH on this machine, so a
    // silent PATH fallback would fail later and far less clearly.
    await assert.rejects(
      () => resolveToolchain({ sdk: resolveSdk(), env: {}, jdkCandidates: [] }),
      (error) => {
        assert(error instanceof BuildError);
        assert.equal(error.code, "E_JDK_NOT_FOUND");
        assert.match(error.details.remediation, /JAVA_HOME/u);
        return true;
      }
    );

    // The Android Studio JBR is the documented fallback on this machine.
    assert(DEFAULT_JDK_CANDIDATES.some((candidate) => candidate.includes("Android Studio")));
  });

  test(
    "the apk builds offline from the installed SDK",
    { timeout: BUILD_TIMEOUT_MS, skip: sdkAvailable() ? false : "no Android SDK on this machine" },
    async () => {
      const result = await buildFixtureApk({ out: OUT });

      try {
        assert.equal(result.packageName, "attest.selfverify");
        assert.equal(existsSync(result.apkPath), true);
        assert(result.bytes > 4096, `apk looks empty at ${result.bytes} bytes`);
        assert.match(result.sha256, /^[a-f0-9]{64}$/u);

        // A real APK is a zip whose first entry header is PK\x03\x04, and it
        // must carry the dex the activity was compiled into.
        const bytes = await readFile(result.apkPath);
        assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
        assert(bytes.includes(Buffer.from("classes.dex")), "apk must contain classes.dex");
      } finally {
        await rm(path.dirname(path.resolve(OUT)), { recursive: true, force: true });
      }
    }
  );
});
