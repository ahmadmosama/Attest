import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import yaml from "yaml";

/**
 * Snapfit, as the first real third party app Attest binds to.
 *
 * Everything else in `examples/` is a fixture written to be testable. Snapfit
 * (github.com/ahmadmosama/Snapfit) is a real Expo app that shipped without a
 * single testID, and binding it is what proved the binding layer's central
 * claim: one set of scenario files, two mobile surfaces, no platform detail
 * anywhere in the scenario.
 */

const BINDINGS_DIR = "examples/snapfit/bindings/snapfit";
const SCENARIOS_DIR = "examples/snapfit/scenarios";

async function readYaml(file) {
  return yaml.parse(await readFile(file, "utf8"));
}

describe("the Snapfit example", () => {
  test("the android and ios bindings differ ONLY in the surface line", async () => {
    const android = await readFile(path.join(BINDINGS_DIR, "android.yaml"), "utf8");
    const ios = await readFile(path.join(BINDINGS_DIR, "ios.yaml"), "utf8");

    // In React Native a testID becomes accessibilityIdentifier on iOS and
    // resource-id on Android, so the identifier is genuinely the same on both.
    // If these two files ever diverge beyond the surface line, either the app
    // grew a platform specific control or somebody worked around a locator bug
    // in the bindings instead of fixing it.
    const normalise = (text) =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("# Snapfit,") && !line.startsWith("surface:"))
        .join("\n");

    assert.equal(normalise(android), normalise(ios));
    assert.match(android, /^surface: android$/mu);
    assert.match(ios, /^surface: ios$/mu);
  });

  test("every semantic ref a scenario names is bound on BOTH surfaces", async () => {
    const bindings = {};
    for (const surface of ["android", "ios"]) {
      const parsed = await readYaml(path.join(BINDINGS_DIR, `${surface}.yaml`));
      bindings[surface] = new Set([
        ...Object.keys(parsed.elements ?? {}),
        ...Object.keys(parsed.screens ?? {}),
        ...Object.keys(parsed.states ?? {})
      ]);
    }

    const files = (await readdir(SCENARIOS_DIR)).filter((name) => name.endsWith(".attest.yaml"));
    assert.ok(files.length >= 2, "the example should carry more than one scenario");

    const referenced = new Set();
    for (const file of files) {
      const text = await readFile(path.join(SCENARIOS_DIR, file), "utf8");
      // Only the step lines, so a ref mentioned in a comment is not counted.
      for (const line of text.split("\n").filter((entry) => entry.trimStart().startsWith("-"))) {
        for (const match of line.matchAll(/\b([a-z]+):([a-z][a-z0-9_]*)\b/gu)) {
          referenced.add(`${match[1]}:${match[2]}`);
        }
      }
    }

    for (const ref of referenced) {
      for (const surface of ["android", "ios"]) {
        assert.ok(
          bindings[surface].has(ref),
          `${ref} is used by a scenario but not bound for ${surface}`
        );
      }
    }
  });

  test("no scenario names a selector, a platform or a URL", async () => {
    // The load bearing property. The moment a scenario mentions a testID or a
    // platform, the same file stops running on both surfaces and the binding
    // layer has been bypassed.
    for (const file of await readdir(SCENARIOS_DIR)) {
      const text = await readFile(path.join(SCENARIOS_DIR, file), "utf8");
      const steps = text
        .split("\n")
        .filter((line) => line.trimStart().startsWith("-"))
        .join("\n");

      assert.doesNotMatch(steps, /testId|accessibilityId|resource-id|xpath|css/iu, file);
      assert.doesNotMatch(steps, /\bandroid\b|\bios\b|https?:\/\//iu, file);
    }
  });

  test("the scenarios stay runnable without Snapfit's backend", async () => {
    // Snapfit's search and size endpoints both call the API. A smoke test that
    // needs a server running is a smoke test that gets skipped, so these two
    // stop before submitting and say so.
    const size = await readFile(path.join(SCENARIOS_DIR, "size_profile.attest.yaml"), "utf8");

    assert.doesNotMatch(size, /^\s*-\s*tap:\s*button:size_submit/mu);
    assert.match(size, /Stops short of submitting/u);
  });
});
