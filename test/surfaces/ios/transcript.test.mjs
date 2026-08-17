import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../../../src/cli/commands/run.mjs";
import {
  buildSessionCapabilities,
  buildSimctlCommand,
  IOS_COMMANDS
} from "../../../src/surfaces/ios/commands.mjs";

const SNAPSHOT = "test/surfaces/ios/__snapshots__/ios-commands.json";
const SOURCE = "src/surfaces/ios/commands.mjs";

const SESSION = Object.freeze({
  xcodeVersion: "16.2",
  runtimeName: "iOS",
  runtimeVersion: "18.2",
  simulatorName: "Attest iPhone 15",
  device: "booted",
  appPath: "build/ios/Build/Products/Debug-iphonesimulator/Runner.app",
  bundleId: "com.example.attest.runner",
  screenshotPath: "artifacts/ios/checkout-open.png"
});

const SCENARIO = `id: mobile.opens_catalog
requirement: [IOS-02]
steps:
  - open: screen:catalog
`;

const BINDINGS = `surface: ios
screens:
  screen:catalog:
    deeplink: shopdemo://catalog
    ready: { accessibilityId: catalog-root }
`;

function transcript() {
  return [
    step("session capabilities", buildSessionCapabilities(SESSION)),
    step("list runtimes", buildSimctlCommand(IOS_COMMANDS.listRuntimes, SESSION)),
    step("assert pinned runtime exists", buildSimctlCommand(IOS_COMMANDS.assertRuntime, SESSION)),
    step("boot named simulator", buildSimctlCommand(IOS_COMMANDS.bootSimulator, SESSION)),
    step("install app bundle", buildSimctlCommand(IOS_COMMANDS.installApp, SESSION)),
    step("launch app", buildSimctlCommand(IOS_COMMANDS.launchApp, SESSION)),
    step("capture screenshot", buildSimctlCommand(IOS_COMMANDS.screenshot, SESSION)),
    step("shutdown simulator", buildSimctlCommand(IOS_COMMANDS.shutdown, SESSION))
  ];
}

function step(name, value) {
  return Object.freeze({ name, value });
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readSnapshot() {
  return JSON.parse(await readFile(SNAPSHOT, "utf8"));
}

function assertCommandDescription(value) {
  assert.equal(Object.isFrozen(value), true);
  assert.equal(typeof value.command, "string");
  assert.equal(Array.isArray(value.args), true);
  assert.equal(Object.isFrozen(value.args), true);
  assert.equal(value.args.every((arg) => typeof arg === "string"), true);
  assert.equal(typeof value.env, "object");
  assert.equal(Object.isFrozen(value.env), true);
}

function assertFrozenTranscript(items) {
  for (const item of items) {
    assert.equal(Object.isFrozen(item), true);
    if (item.value.command !== undefined) {
      assertCommandDescription(item.value);
    }
  }
}

function firstMismatch(actual, expected) {
  const limit = Math.max(actual.length, expected.length);
  for (let index = 0; index < limit; index += 1) {
    if (JSON.stringify(actual[index]) !== JSON.stringify(expected[index])) {
      return index;
    }
  }

  return -1;
}

function assertSnapshot(actual, expected) {
  const index = firstMismatch(actual, expected);
  if (index !== -1) {
    assert.deepEqual(
      actual[index],
      expected[index],
      `iOS command snapshot mismatch at step ${index}: ${actual[index]?.name ?? expected[index]?.name}`
    );
  }

  assert.deepEqual(actual, expected);
}

async function writeSnapshot() {
  await writeFile(SNAPSHOT, stableJson(transcript()));
}

async function withIosCliFixture(fn) {
  const root = await mkdtemp(path.join(process.cwd(), "test/surfaces/ios/run-"));
  try {
    await mkdir(path.join(root, "scenarios"), { recursive: true });
    await mkdir(path.join(root, "bindings", "shop"), { recursive: true });
    await writeFile(path.join(root, "scenarios", "case.attest.yaml"), SCENARIO);
    await writeFile(path.join(root, "bindings", "shop", "ios.yaml"), BINDINGS);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === "update-snapshot") {
  await writeSnapshot();
} else {
  test("iOS command lifecycle matches the committed transcript", async () => {
    const actual = transcript();
    assertFrozenTranscript(actual);
    assertSnapshot(actual, await readSnapshot());
  });

  test("iOS command source cannot spawn processes", async () => {
    const source = await readFile(SOURCE, "utf8");
    assert.doesNotMatch(source, /node:child_process/);
  });

  test("iOS command builders reject device ipa artifacts with the existing code", () => {
    assert.throws(
      () => buildSimctlCommand(IOS_COMMANDS.installApp, { ...SESSION, appPath: "build/Runner.ipa" }),
      (error) => {
        assert.equal(error.code, "E_IOS_DEVICE_ARTIFACT");
        assert.match(error.message, /iOS Simulator cannot install a device \.ipa/);
        assert.match(error.message, /generic\/platform=iOS Simulator/);
        return true;
      }
    );
  });

  test("pinned Xcode and runtime are mandatory inputs", () => {
    assert.throws(
      () => buildSessionCapabilities({ ...SESSION, xcodeVersion: undefined }),
      /Invalid iOS command request/
    );
    assert.throws(
      () => buildSimctlCommand(IOS_COMMANDS.listRuntimes, { ...SESSION, runtimeVersion: undefined }),
      /Invalid iOS command request/
    );
  });

  test("real iOS execution on Windows still fails fast through the existing adapter error", async () => {
    await withIosCliFixture(async (cwd) => {
      const out = [];
      const err = [];
      const artifacts = path.join(cwd, "artifacts");
      const code = await runCommand(
        {
          scenariosGlob: ["scenarios/case.attest.yaml"],
          bindingsDir: "bindings",
          app: "build/Runner.app",
          surfaces: ["ios"],
          artifactRoot: artifacts
        },
        {
          cwd,
          env: {},
          stdout: { write: (text) => out.push(text) },
          stderr: { write: (text) => err.push(text) },
          now: () => new Date("2026-08-17T00:00:00.000Z")
        }
      );

      assert.equal(code, 2, err.join(""));
      assert.equal(err.join(""), "");
      assert.match(out.join(""), /infra/);
      const [runDir] = await readdir(artifacts);
      const record = JSON.parse(await readFile(path.join(artifacts, runDir, "run.json"), "utf8"));
      assert.equal(record.scenarios[0].error.code, "E_ADAPTER_NOT_IMPLEMENTED");
      assert.match(record.scenarios[0].error.message, /Surface adapter for ios is not implemented/);
      // Phase 5 landed Android, so the message no longer names it. iOS is
      // Phase 7, on a macOS runner, and the remediation says so.
      assert.equal(record.scenarios[0].error.details.roadmapPhase, "Phase 7");
    });
  });
}
