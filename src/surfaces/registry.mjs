import { InfraError, UsageError } from "../errors.mjs";
import { defineSurfaceCapabilities } from "../capabilities/surface-caps.mjs";
import { createFakeSurface } from "./fake/adapter.mjs";
import { defineScript } from "./fake/script.mjs";
import { createWebSurface } from "./web/adapter.mjs";

export const SURFACE_ADAPTER_MODES = Object.freeze(["real", "fake"]);

const MODE_SET = new Set(SURFACE_ADAPTER_MODES);

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function unknownModeError(mode) {
  return new UsageError("E_SURFACE_ADAPTER_MODE", "Surface adapter mode must be one of the accepted modes", {
    mode,
    accepted: SURFACE_ADAPTER_MODES
  });
}

function resolveMode({ mode, env }) {
  // Resolution order is explicit option, then environment, then fake script
  // compatibility, then real. Real is the default so the gate does not
  // silently simulate execution unless the caller asked for it.
  const resolved =
    mode ??
    env?.ATTEST_SURFACE_ADAPTER ??
    (env?.ATTEST_FAKE_SCRIPT === undefined ? "real" : "fake");

  if (!MODE_SET.has(resolved)) {
    throw unknownModeError(resolved);
  }

  return resolved;
}

function parseFakeScript(env) {
  if (env?.ATTEST_FAKE_SCRIPT === undefined) {
    return {};
  }

  return JSON.parse(env.ATTEST_FAKE_SCRIPT);
}

function fakeScriptFor(surface, env) {
  const script = parseFakeScript(env);
  return defineScript({ unknownKind: "ok", ...script, surface });
}

function fakeAdapterFor(surface, env) {
  return createFakeSurface(fakeScriptFor(surface, env));
}

function fakeDescriptorFor(surface, env) {
  return fakeAdapterFor(surface, env).describeCapabilities();
}

function notImplementedDescriptor(surface) {
  return defineSurfaceCapabilities({ surface, supports: [] });
}

function notImplementedError(surface) {
  return new InfraError(
    "E_ADAPTER_NOT_IMPLEMENTED",
    `Surface adapter for ${surface} is not implemented until Phase 5`,
    {
      surface,
      roadmapPhase: "Phase 5",
      remediation: "Use ATTEST_SURFACE_ADAPTER=fake for Phase 1 contract tests, or run this surface when the Phase 5 adapter lands."
    }
  );
}

function assertWebTarget(appArtifact) {
  if (appArtifact?.kind === "web_url" && isHttpUrl(appArtifact.url)) {
    return appArtifact.url;
  }

  throw new UsageError("E_WEB_APP_REQUIRED", "Web surface requires an http or https app target", {
    surface: "web",
    artifactKind: appArtifact?.kind ?? null,
    app: appArtifact?.url ?? appArtifact?.path ?? null
  });
}

function createRealWebFactory({ appArtifact, config }) {
  const baseUrl = assertWebTarget(appArtifact);
  return () =>
    createWebSurface({
      baseUrl,
      channel: config.web.channel,
      testIdAttribute: config.web.testIdAttribute,
      viewport: config.web.viewport,
      timeouts: config.timeouts
    });
}

function createRealRegistry({ surfaces, appArtifact, config }) {
  const webFactory = surfaces.includes("web") ? createRealWebFactory({ appArtifact, config }) : null;
  const descriptorCache = new Map();

  function descriptorFor(surface) {
    if (descriptorCache.has(surface)) {
      return descriptorCache.get(surface);
    }

    const descriptor =
      surface === "web" && webFactory !== null
        ? webFactory().describeCapabilities()
        : notImplementedDescriptor(surface);
    descriptorCache.set(surface, descriptor);
    return descriptor;
  }

  function adapterFor(plan) {
    const surface = plan?.surface;
    if (surface === "web" && webFactory !== null) {
      return webFactory();
    }

    throw notImplementedError(surface);
  }

  return Object.freeze({ descriptorFor, adapterFor });
}

function createFakeRegistry({ env }) {
  const descriptorCache = new Map();

  function descriptorFor(surface) {
    if (!descriptorCache.has(surface)) {
      descriptorCache.set(surface, fakeDescriptorFor(surface, env));
    }
    return descriptorCache.get(surface);
  }

  function adapterFor(plan) {
    return fakeAdapterFor(plan?.surface, env);
  }

  return Object.freeze({ descriptorFor, adapterFor });
}

export function createSurfaceRegistry({
  mode,
  surfaces = ["web"],
  appArtifact = null,
  config,
  env = {}
} = {}) {
  const resolvedMode = resolveMode({ mode, env });
  const normalizedSurfaces = Object.freeze([...surfaces]);
  const registry =
    resolvedMode === "fake"
      ? createFakeRegistry({ env })
      : createRealRegistry({ surfaces: normalizedSurfaces, appArtifact, config });

  return Object.freeze({
    mode: resolvedMode,
    descriptorFor: registry.descriptorFor,
    adapterFor: registry.adapterFor
  });
}
