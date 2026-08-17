import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import { AttestError, InfraError, UnsupportedOpError } from "../../src/errors.mjs";
import { SURFACE_CAPABILITIES } from "../../src/capabilities/registry.mjs";
import {
  SURFACE_PORT_METHODS,
  assertImplementsSurfacePort
} from "../../src/surfaces/port.mjs";

const DEFAULT_TIMEOUTS = Object.freeze({
  stepMs: 150,
  scenarioMs: 1000,
  preflightMs: 150,
  openMs: 1000,
  evidenceMs: 1000,
  closeMs: 1000
});

const UNSUPPORTED_OPS = Object.freeze([
  Object.freeze({
    capability: "file_upload",
    op: Object.freeze({
      i: 11,
      kind: "upload_file",
      locator: Object.freeze({ strategy: "testId", value: "upload" }),
      path: "missing.txt"
    })
  }),
  Object.freeze({
    capability: "app_lifecycle",
    op: Object.freeze({ i: 10, kind: "app_background" })
  }),
  Object.freeze({
    capability: "network_control",
    op: Object.freeze({ i: 12, kind: "set_network", mode: "offline" })
  }),
  Object.freeze({
    capability: "permission_control",
    op: Object.freeze({ i: 13, kind: "set_permission", name: "geolocation", value: true })
  }),
  Object.freeze({
    capability: "clipboard_control",
    op: Object.freeze({ i: 14, kind: "set_clipboard", value: "conformance" })
  })
]);

const DEFAULT_SUPPORTED_OP = Object.freeze({
  i: 20,
  kind: "raw",
  block: Object.freeze({ script: "() => true" })
});

const DEFAULT_MISSING_LOCATOR_OP = Object.freeze({
  i: 30,
  kind: "expect_visible",
  locator: Object.freeze({ strategy: "testId", value: "attest_missing_locator" })
});

function freezeReference(reference) {
  return Object.freeze({ ...reference });
}

function memoryBundle() {
  let seq = 0;
  function reference(kind, data, ext) {
    const current = String(seq).padStart(3, "0");
    seq += 1;
    return freezeReference({
      kind,
      path: `memory/evidence/${current}-${kind}.${ext}`,
      bytes: Buffer.byteLength(data)
    });
  }

  return Object.freeze({
    dir: null,
    writeTextArtifact(kind, text) {
      return reference(kind, String(text), "txt");
    },
    writeArtifact(kind, data) {
      return reference(kind, data, "bin");
    },
    writeJson(kind, value) {
      return reference(kind, JSON.stringify(value), "json");
    },
    write(kind, data) {
      return reference(kind, data, "bin");
    }
  });
}

function defaultContext(name) {
  return Object.freeze({
    runId: `surface-conformance-${name}`,
    scenarioId: `${name}.surface_conformance`,
    surface: name,
    headed: false,
    bundle: memoryBundle(),
    timeouts: DEFAULT_TIMEOUTS,
    now: () => new Date("2026-08-17T00:00:00.000Z")
  });
}

async function createContextResource(name, createContext) {
  if (typeof createContext !== "function") {
    return Object.freeze({
      ctx: defaultContext(name),
      cleanup: async () => {}
    });
  }

  const produced = await createContext();
  if (produced?.ctx !== undefined) {
    return Object.freeze({
      ctx: produced.ctx,
      cleanup: produced.cleanup ?? (async () => {})
    });
  }

  return Object.freeze({
    ctx: produced,
    cleanup: async () => {}
  });
}

function adapterFrom(resource) {
  return resource?.adapter ?? resource;
}

function cleanupFrom(resource) {
  return resource?.cleanup ?? (async () => {});
}

async function createAdapterResource(createAdapter, ctx, t) {
  const produced = await createAdapter({ ctx, t });
  const adapter = adapterFrom(produced);
  assertImplementsSurfacePort(adapter);
  return Object.freeze({
    adapter,
    cleanup: cleanupFrom(produced)
  });
}

function descriptorSupports(descriptor) {
  if (Array.isArray(descriptor?.supports)) {
    return Object.freeze([...descriptor.supports]);
  }

  return Object.freeze(SURFACE_CAPABILITIES.filter((capability) => descriptor?.has?.(capability)));
}

function expectedCapabilities(value) {
  if (Array.isArray(value)) {
    return Object.freeze([...value]);
  }

  if (value?.supports !== undefined) {
    return descriptorSupports(value);
  }

  return null;
}

function skipCase(t, skip, reason) {
  if (typeof skip === "function") {
    skip(t, reason);
    return;
  }

  t.skip(reason);
}

function skippableReason(error, isSkippableSetupError) {
  if (typeof isSkippableSetupError !== "function") {
    return null;
  }

  const reason = isSkippableSetupError(error);
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}

async function withAdapter(options, t, fn) {
  const { name, createContext, createAdapter, isSkippableSetupError, skip } = options;
  let contextResource;
  let adapterResource;

  try {
    contextResource = await createContextResource(name, createContext);
    adapterResource = await createAdapterResource(createAdapter, contextResource.ctx, t);
    return await fn(adapterResource.adapter, contextResource.ctx);
  } catch (error) {
    const reason = skippableReason(error, isSkippableSetupError);
    if (reason !== null) {
      skipCase(t, skip, reason);
      return undefined;
    }

    throw error;
  } finally {
    if (adapterResource !== undefined) {
      await adapterResource.cleanup();
    }
    if (contextResource !== undefined) {
      await contextResource.cleanup();
    }
  }
}

async function withSession(options, t, fn) {
  return withAdapter(options, t, async (adapter, ctx) => {
    const session = await adapter.open(ctx);
    try {
      return await fn(adapter, session, ctx);
    } finally {
      await adapter.close(session);
    }
  });
}

function assertDescriptor(name, descriptor, capabilities) {
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(descriptor.surface, name);
  assert.equal(typeof descriptor.has, "function");
  assert.equal(Object.isFrozen(descriptor.supports), true);
  assert.equal(Object.isFrozen(descriptor.degraded), true);

  const expected = expectedCapabilities(capabilities);
  if (expected !== null) {
    assert.deepEqual(descriptorSupports(descriptor), expected);
  }
}

function assertPortMethods(adapter) {
  assert.doesNotThrow(() => assertImplementsSurfacePort(adapter));
  for (const method of SURFACE_PORT_METHODS) {
    assert.equal(typeof adapter[method], "function", method);
  }
}

function assertOkResult(result) {
  assert.equal(result?.ok, true);
  assert.equal(Object.isFrozen(result), true);
}

function unsupportedOpFor(descriptor) {
  return UNSUPPORTED_OPS.find((entry) => !descriptor.has(entry.capability)) ?? null;
}

function skipMissingCapability(t, skip, capability) {
  skipCase(t, skip, `adapter declares no ${capability} capability`);
}

async function assertThrowsAny(fn, predicate) {
  try {
    await fn();
  } catch (error) {
    assert.equal(predicate(error), true);
    return error;
  }

  assert.fail("expected operation to throw");
}

function isAbortReason(error, reason) {
  return error === reason || error?.name === "AbortError";
}

function isLocatorTaxonomyError(error) {
  return error instanceof AttestError && !(error instanceof InfraError);
}

function isArtifactReference(reference) {
  return (
    reference !== null &&
    typeof reference === "object" &&
    Object.isFrozen(reference) &&
    typeof reference.kind === "string" &&
    reference.kind.length > 0 &&
    typeof reference.bytes === "number" &&
    reference.bytes >= 0 &&
    (reference.path === null || typeof reference.path === "string")
  );
}

function maybePromise(value) {
  return Promise.resolve(value);
}

function registerCapabilitiesCase(options) {
  const { name, test, capabilities } = options;

  test(`${name}: describeCapabilities returns a frozen descriptor for the surface`, async (t) => {
    await withAdapter(options, t, async (adapter) => {
      assertDescriptor(name, adapter.describeCapabilities(), capabilities);
    });
  });
}

function registerPortCase(options) {
  const { name, test } = options;

  test(`${name}: every surface port method exists`, async (t) => {
    await withAdapter(options, t, async (adapter) => {
      assertPortMethods(adapter);
    });
  });
}

function registerPreflightCase(options) {
  const { name, test } = options;

  test(`${name}: preflight returns a frozen ok result`, async (t) => {
    await withAdapter(options, t, async (adapter, ctx) => {
      const result = await maybePromise(adapter.preflight(ctx));
      assertOkResult(result);
    });
  });
}

function registerUnsupportedCase(options) {
  const { name, test, skip } = options;

  test(`${name}: unsupported capability raises E_UNSUPPORTED_OP`, async (t) => {
    await withSession(options, t, async (adapter, session) => {
      const descriptor = adapter.describeCapabilities();
      const unsupported = unsupportedOpFor(descriptor);
      if (unsupported === null) {
        skipCase(t, skip, "adapter declares every optional surface capability");
        return;
      }

      await assertThrowsAny(
        () => maybePromise(adapter.execute(session, unsupported.op)),
        (error) =>
          error instanceof UnsupportedOpError &&
          error.code === "E_UNSUPPORTED_OP" &&
          error.details.missing.includes(unsupported.capability)
      );
    });
  });
}

function registerSupportedCase(options) {
  const { name, test, skip, supportedCapability = "raw_escape", supportedOp = DEFAULT_SUPPORTED_OP } = options;

  test(`${name}: supported operation returns a frozen ok result`, async (t) => {
    await withSession(options, t, async (adapter, session) => {
      if (!adapter.describeCapabilities().has(supportedCapability)) {
        skipMissingCapability(t, skip, supportedCapability);
        return;
      }

      const result = await maybePromise(adapter.execute(session, supportedOp));
      assertOkResult(result);
      assert.equal(Object.isFrozen(result.detail), true);
    });
  });
}

function registerLocatorCase(options) {
  const { name, test, missingLocatorOp = DEFAULT_MISSING_LOCATOR_OP } = options;

  test(`${name}: unresolved locator fails with declared taxonomy`, async (t) => {
    await withSession(options, t, async (adapter, session) => {
      await assertThrowsAny(
        () => maybePromise(adapter.execute(session, missingLocatorOp)),
        (error) =>
          isLocatorTaxonomyError(error) &&
          typeof error.code === "string" &&
          error.code.startsWith("E_")
      );
    });
  });
}

function registerEvidenceCase(options) {
  const { name, test, evidenceKind = "failure" } = options;

  test(`${name}: evidence capture returns an artifact reference`, async (t) => {
    await withSession(options, t, async (adapter, session, ctx) => {
      const reference = await maybePromise(
        adapter.collectEvidence(session, evidenceKind, { bundle: ctx.bundle })
      );
      assert.equal(isArtifactReference(reference), true);
    });
  });
}

function registerFailureEvidenceCase(options) {
  const { name, test, missingLocatorOp = DEFAULT_MISSING_LOCATOR_OP, evidenceKind = "failure" } = options;

  test(`${name}: failing step can still return evidence`, async (t) => {
    await withSession(options, t, async (adapter, session, ctx) => {
      await assertThrowsAny(
        () => maybePromise(adapter.execute(session, missingLocatorOp)),
        (error) => error instanceof AttestError
      );
      const reference = await maybePromise(
        adapter.collectEvidence(session, evidenceKind, { bundle: ctx.bundle })
      );
      assert.equal(isArtifactReference(reference), true);
    });
  });
}

function registerCloseCase(options) {
  const { name, test } = options;

  test(`${name}: close is idempotent`, async (t) => {
    await withAdapter(options, t, async (adapter, ctx) => {
      const session = await adapter.open(ctx);
      await assert.doesNotReject(() => maybePromise(adapter.close(session)));
      await assert.doesNotReject(() => maybePromise(adapter.close(session)));
    });
  });
}

function registerAbortCase(options) {
  const { name, test, skip, supportedCapability = "raw_escape", supportedOp = DEFAULT_SUPPORTED_OP } = options;

  test(`${name}: aborted signal surfaces the abort reason`, async (t) => {
    await withSession(options, t, async (adapter, session) => {
      if (!adapter.describeCapabilities().has(supportedCapability)) {
        skipMissingCapability(t, skip, supportedCapability);
        return;
      }

      const controller = new AbortController();
      const reason = new Error("surface conformance abort");
      controller.abort(reason);

      await assertThrowsAny(
        () => maybePromise(adapter.execute(session, supportedOp, { signal: controller.signal })),
        (error) => isAbortReason(error, reason)
      );
    });
  });
}

function assertOptions(options) {
  assert.equal(typeof options?.name, "string");
  assert.equal(options.name.length > 0, true);
  assert.equal(typeof options.createAdapter, "function");
  assert.equal(typeof options.describe, "function");
  assert.equal(typeof options.test, "function");
}

export function runSurfaceConformance(options) {
  assertOptions(options);
  const { name, describe } = options;

  describe(`${name} surface adapter conformance`, () => {
    registerCapabilitiesCase(options);
    registerPortCase(options);
    registerPreflightCase(options);
    registerSupportedCase(options);
    registerUnsupportedCase(options);
    registerLocatorCase(options);
    registerEvidenceCase(options);
    registerFailureEvidenceCase(options);
    registerCloseCase(options);
    registerAbortCase(options);
  });
}
