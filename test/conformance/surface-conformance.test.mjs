import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";

import { createBundle } from "../../src/evidence/bundle.mjs";
import { createRunContext } from "../../src/runtime/run-context.mjs";
import { InfraError } from "../../src/errors.mjs";
import { createFakeSurface } from "../../src/surfaces/fake/adapter.mjs";
import { defineScript } from "../../src/surfaces/fake/script.mjs";
import { WEB_SURFACE_SUPPORTS } from "../../src/surfaces/web/capabilities.mjs";
import { createWebSurface } from "../../src/surfaces/web/adapter.mjs";
import { startStaticServer } from "../helpers/static-server.mjs";
import { runSurfaceConformance } from "./surface-port.mjs";

const FIXTURE_DIR = path.resolve("test/fixtures/web-app");
const RUN_ID = "20260817T000000Z-04020000";
const TEST_TIMEOUT = 120000;
const STEP_TIMEOUT_MS = 150;

function skip(t, reason) {
  t.skip(reason);
}

function clock() {
  return new Date("2026-08-17T00:00:00.000Z");
}

function fakeScript() {
  return defineScript({
    surface: "fake",
    supports: ["raw_escape"],
    byKind: {
      expect_visible: {
        outcome: "fail",
        message: "fake locator did not resolve"
      }
    }
  });
}

function fakeContext() {
  const bundle = Object.freeze({
    dir: null,
    writeTextArtifact(kind, text) {
      return Object.freeze({
        kind,
        path: null,
        bytes: Buffer.byteLength(String(text))
      });
    },
    writeArtifact(kind, data) {
      return Object.freeze({
        kind,
        path: null,
        bytes: Buffer.byteLength(data)
      });
    },
    writeJson(kind, value) {
      return Object.freeze({
        kind,
        path: null,
        bytes: Buffer.byteLength(JSON.stringify(value))
      });
    },
    write(kind, data) {
      return Object.freeze({
        kind,
        path: null,
        bytes: Buffer.byteLength(data)
      });
    }
  });

  return Object.freeze({
    runId: "surface-conformance-fake",
    scenarioId: "fake.surface_conformance",
    surface: "fake",
    headed: false,
    bundle,
    timeouts: Object.freeze({ stepMs: STEP_TIMEOUT_MS }),
    now: clock
  });
}

function tmpRootFor(prefix) {
  return path.join(process.cwd(), "test", ".tmp-surface-conformance", prefix);
}

async function webContext() {
  const root = await mkdtemp(tmpRootFor("web-"));
  const bundle = await createBundle({ root, runId: RUN_ID });
  const ctx = createRunContext({
    runId: bundle.runId,
    scenarioId: "web.surface_conformance",
    surface: "web",
    bundle,
    headed: false,
    timeouts: {
      stepMs: STEP_TIMEOUT_MS,
      evidenceMs: 1000,
      closeMs: 5000
    },
    now: clock
  });

  return Object.freeze({
    ctx,
    cleanup: () => rm(root, { recursive: true, force: true })
  });
}

function chromeSkipReason(error) {
  if (
    error instanceof InfraError &&
    (error.code === "E_ADAPTER_BROWSER_LAUNCH" || error.code === "E_ADAPTER_BROWSER_MISSING")
  ) {
    return error.details.remediation ?? "Google Chrome is not available";
  }

  return null;
}

function webWrapper(adapter, server) {
  let closed = false;

  async function closeServer() {
    if (closed) {
      return;
    }

    closed = true;
    await server.close();
  }

  return Object.freeze({
    describeCapabilities: (...args) => adapter.describeCapabilities(...args),
    preflight: (...args) => adapter.preflight(...args),
    open: (...args) => adapter.open(...args),
    execute: (...args) => adapter.execute(...args),
    collectEvidence: (...args) => adapter.collectEvidence(...args),
    async close(session) {
      try {
        return await adapter.close(session);
      } finally {
        await closeServer();
      }
    },
    cleanup: closeServer
  });
}

async function createWebAdapter() {
  const server = await startStaticServer({ dir: FIXTURE_DIR });
  try {
    const adapter = createWebSurface({ baseUrl: server.url, channel: "chrome" });
    return webWrapper(adapter, server);
  } catch (error) {
    await server.close();
    throw error;
  }
}

runSurfaceConformance({
  name: "fake",
  createAdapter: async () => createFakeSurface(fakeScript()),
  createContext: fakeContext,
  capabilities: ["raw_escape"],
  describe,
  test
});

describe("web surface adapter conformance", { timeout: TEST_TIMEOUT }, () => {
  test.before(async () => {
    await mkdir(tmpRootFor("root"), { recursive: true });
  });

  test.after(async () => {
    await rm(path.join(process.cwd(), "test", ".tmp-surface-conformance"), {
      recursive: true,
      force: true
    });
  });

  runSurfaceConformance({
    name: "web",
    createAdapter: createWebAdapter,
    createContext: webContext,
    capabilities: WEB_SURFACE_SUPPORTS,
    describe,
    test,
    skip,
    isSkippableSetupError: chromeSkipReason
  });
});
