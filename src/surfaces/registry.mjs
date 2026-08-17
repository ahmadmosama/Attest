import { InfraError, UsageError } from "../errors.mjs";
import { defineSurfaceCapabilities } from "../capabilities/surface-caps.mjs";
import { createAndroidSurface } from "./android/adapter.mjs";
import { createDeviceLease } from "./android/device.mjs";
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
    `Surface adapter for ${surface} is not implemented`,
    {
      surface,
      roadmapPhase: surface === "ios" ? "Phase 7" : "unplanned",
      remediation:
        surface === "ios"
          ? "iOS executes on a GitHub Actions macOS runner from Phase 7. Use ATTEST_SURFACE_ADAPTER=fake for contract tests."
          : "Use ATTEST_SURFACE_ADAPTER=fake for contract tests, or run a surface that has an adapter."
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

function assertAndroidTarget(appArtifact) {
  if (appArtifact?.kind === "android_apk" && typeof appArtifact.path === "string") {
    return appArtifact.path;
  }

  throw new UsageError("E_ANDROID_APP_REQUIRED", "Android surface requires an .apk app target", {
    surface: "android",
    artifactKind: appArtifact?.kind ?? null,
    app: appArtifact?.path ?? appArtifact?.url ?? null
  });
}

function assertAndroidPackage(android) {
  if (typeof android?.package === "string" && android.package.length > 0) {
    return android.package;
  }

  // Refused rather than inferred from the APK. Reading the manifest would need
  // aapt, and guessing the package is how a run force-stops or launches the
  // wrong app and then reports a locator failure.
  throw new UsageError("E_ANDROID_PACKAGE_REQUIRED", "Android surface requires android.package", {
    surface: "android",
    remediation: "Set android.package, and android.activity when the launcher activity is not .MainActivity."
  });
}

function createRealAndroidFactory({ appArtifact, config, env, deps }) {
  const android = config.android ?? {};
  const apkPath = assertAndroidTarget(appArtifact);
  const packageName = assertAndroidPackage(android);

  // One lease for the whole run: N scenarios share one boot and one install.
  const lease = createDeviceLease({
    avd: android.avd ?? null,
    serial: android.serial ?? null,
    apkPath,
    packageName,
    install: android.install !== false,
    bootTimeoutMs: android.bootTimeoutMs ?? 180000,
    env,
    deps
  });

  const factory = () =>
    createAndroidSurface({
      lease,
      packageName,
      activity: android.activity ?? null,
      extras: Object.keys(android.extras ?? {}).length === 0 ? null : android.extras,
      record: android.record !== false,
      recordSeconds: android.recordSeconds ?? 180,
      deps
    });

  factory.shutdown = () => lease.shutdown();
  return factory;
}

function createRealRegistry({ surfaces, appArtifact, config, env, deps }) {
  const webFactory = surfaces.includes("web") ? createRealWebFactory({ appArtifact, config }) : null;
  const androidFactory = surfaces.includes("android")
    ? createRealAndroidFactory({ appArtifact, config, env, deps })
    : null;
  const descriptorCache = new Map();

  function factoryFor(surface) {
    if (surface === "web") {
      return webFactory;
    }
    if (surface === "android") {
      return androidFactory;
    }
    return null;
  }

  function descriptorFor(surface) {
    if (descriptorCache.has(surface)) {
      return descriptorCache.get(surface);
    }

    const factory = factoryFor(surface);
    const descriptor =
      factory === null ? notImplementedDescriptor(surface) : factory().describeCapabilities();
    descriptorCache.set(surface, descriptor);
    return descriptor;
  }

  function adapterFor(plan) {
    const factory = factoryFor(plan?.surface);
    if (factory === null) {
      throw notImplementedError(plan?.surface);
    }

    return factory();
  }

  async function shutdown() {
    if (typeof androidFactory?.shutdown === "function") {
      await androidFactory.shutdown();
    }

    return Object.freeze({ ok: true });
  }

  return Object.freeze({ descriptorFor, adapterFor, shutdown });
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

  async function shutdown() {
    return Object.freeze({ ok: true });
  }

  return Object.freeze({ descriptorFor, adapterFor, shutdown });
}

export function createSurfaceRegistry({
  mode,
  surfaces = ["web"],
  appArtifact = null,
  config,
  env = {},
  deps = {}
} = {}) {
  const resolvedMode = resolveMode({ mode, env });
  const normalizedSurfaces = Object.freeze([...surfaces]);
  const registry =
    resolvedMode === "fake"
      ? createFakeRegistry({ env })
      : createRealRegistry({ surfaces: normalizedSurfaces, appArtifact, config, env, deps });

  return Object.freeze({
    mode: resolvedMode,
    descriptorFor: registry.descriptorFor,
    adapterFor: registry.adapterFor,
    // Run scoped teardown. The web adapter closes per session, but an emulator
    // outlives every session in the run and has to be stopped once at the end.
    shutdown: registry.shutdown
  });
}
