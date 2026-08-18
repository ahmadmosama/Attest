import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RuntimeSelectionError, compareVersions, selectRuntime } from "../../tools/select-ios-runtime.mjs";

/**
 * The runtimes the real macos-26 image reported on 2026-08-18, transcribed from
 * the failing run's log rather than invented.
 *
 * The exact pin was `26.1`, Xcode 26.1.1 was installed, and the 26.1 runtime was
 * simply not there. This fixture is that fact, kept where it can fail a test
 * instead of a CI job.
 */
const MACOS_26_IMAGE = {
  runtimes: [
    {
      name: "iOS 26.2",
      version: "26.2",
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-2",
      platform: "iOS",
      isAvailable: true
    },
    {
      // The display name says 26.4, the build says 26.4.1, and the identifier
      // says iOS-26-4. Three different strings for one runtime.
      name: "iOS 26.4",
      version: "26.4.1",
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-4",
      platform: "iOS",
      isAvailable: true
    },
    {
      name: "iOS 26.5",
      version: "26.5",
      identifier: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
      platform: "iOS",
      isAvailable: true
    },
    {
      name: "tvOS 26.5",
      version: "26.5",
      identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-26-5",
      platform: "tvOS",
      isAvailable: true
    },
    {
      name: "watchOS 26.5",
      version: "26.5",
      identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-26-5",
      platform: "watchOS",
      isAvailable: true
    },
    {
      name: "visionOS 26.5",
      version: "26.5",
      identifier: "com.apple.CoreSimulator.SimRuntime.xrOS-26-5",
      platform: "xrOS",
      isAvailable: true
    }
  ]
};

describe("selecting the iOS simulator runtime", () => {
  test("takes the newest iOS runtime at or above the floor", () => {
    const chosen = selectRuntime(MACOS_26_IMAGE, { minVersion: "26.2" });

    assert.equal(chosen.identifier, "com.apple.CoreSimulator.SimRuntime.iOS-26-5");
    assert.equal(chosen.version, "26.5");
  });

  test("returns the IDENTIFIER, never a string rebuilt from the version", () => {
    // "iOS 26.4" reports version 26.4.1 and identifier iOS-26-4. Rebuilding the
    // id from the version would produce `iOS-26-4-1`, and simctl create would
    // fail with an unhelpful "invalid runtime".
    const chosen = selectRuntime(
      { runtimes: [MACOS_26_IMAGE.runtimes[1]] },
      { minVersion: "26.2" }
    );

    assert.equal(chosen.identifier, "com.apple.CoreSimulator.SimRuntime.iOS-26-4");
    assert.equal(chosen.version, "26.4.1");
    assert.doesNotMatch(chosen.identifier, /26-4-1/u);
  });

  test("ignores tvOS, watchOS and visionOS, which all ship on the same image", () => {
    const chosen = selectRuntime(MACOS_26_IMAGE, { minVersion: "26.5" });
    assert.match(chosen.identifier, /SimRuntime\.iOS-/u);
  });

  test("ignores a runtime the image lists but cannot boot", () => {
    // isAvailable: false runtimes appear in the listing. Treating one as usable
    // produces a confusing boot failure much later.
    const chosen = selectRuntime(
      {
        runtimes: [
          { name: "iOS 26.9", version: "26.9", identifier: "x.iOS-26-9", platform: "iOS", isAvailable: false },
          MACOS_26_IMAGE.runtimes[0]
        ]
      },
      { minVersion: "26.2" }
    );

    assert.equal(chosen.version, "26.2");
  });

  test("the exact pin that broke the first real run now fails with what IS there", () => {
    // The original workflow asked for 26.1 on an image that had 26.2, 26.4 and
    // 26.5. The error has to say what to change the floor TO, not only that the
    // floor is wrong.
    assert.throws(
      () => selectRuntime(MACOS_26_IMAGE, { minVersion: "27.0" }),
      (error) => {
        assert.ok(error instanceof RuntimeSelectionError);
        assert.match(error.message, /at or above 27\.0/u);
        assert.ok(error.details.available.some((name) => name.includes("iOS 26.5")));
        assert.equal(error.details.available.some((name) => name.includes("tvOS")), false);
        return true;
      }
    );
  });

  test("versions compare numerically, not as strings", () => {
    // A string sort puts "26.10" below "26.9", which would silently select an
    // older runtime the first time Apple ships a tenth point release.
    assert.ok(compareVersions("26.10", "26.9") > 0);
    assert.ok(compareVersions("26.2", "26.10") < 0);
    assert.equal(compareVersions("26", "26.0"), 0);

    const chosen = selectRuntime(
      {
        runtimes: [
          { name: "iOS 26.9", version: "26.9", identifier: "x.iOS-26-9", platform: "iOS", isAvailable: true },
          { name: "iOS 26.10", version: "26.10", identifier: "x.iOS-26-10", platform: "iOS", isAvailable: true }
        ]
      },
      { minVersion: "26.2" }
    );

    assert.equal(chosen.version, "26.10");
  });

  test("unparseable simctl output is refused rather than read as an empty image", () => {
    assert.throws(() => selectRuntime("{}", { minVersion: "26.2" }), RuntimeSelectionError);
    assert.throws(() => selectRuntime(MACOS_26_IMAGE, {}), RuntimeSelectionError);
  });
});
