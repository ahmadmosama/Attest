import { assertImplementsDbPort } from "./port.mjs";
import { applySeed, assertPreState } from "./seed.mjs";
import { openTenantKeys, provisionTenant, sweepStaleTenants, teardownTenant, tenantPrefixFor } from "./tenancy.mjs";
import { assertDelta } from "../delta/assert.mjs";
import { classifyChanges, createDeltaResult } from "../delta/classify.mjs";
import { groupUnexplained } from "../delta/failure.mjs";
import { enforceCaps } from "../delta/rules/caps.mjs";
import { compileRuleset, createRuleEngine } from "../delta/rules/engine.mjs";
import { hashRuleset } from "../delta/rules/hash.mjs";
import { assessRuleHealth, createRuleHealthStore } from "../delta/rules/health.mjs";
import { RULESET_VERSION } from "../delta/rules/schema.mjs";
import { AttestError, InfraError } from "../errors.mjs";

const EMPTY_RULESET = Object.freeze({
  version: RULESET_VERSION,
  rules: Object.freeze([])
});

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function throwIfAborted(signal, code, message) {
  if (signal?.aborted === true) {
    throw new InfraError(code, message, {
      reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "aborted")
    });
  }
}

function assertDeltaCapable(capabilities) {
  const supported = typeof capabilities?.has === "function"
    ? capabilities.has("db.delta_assertion")
    : capabilities?.deltaAssertion === true || asArray(capabilities?.supports).includes("db.delta_assertion");

  if (!supported) {
    throw new AttestError("E_DB_DELTA_UNSUPPORTED", "Database driver does not support delta assertions.", {
      driver: capabilities?.driver ?? "unknown"
    });
  }
}

function describeAtConstruction(driver) {
  try {
    return driver.describeCapabilities();
  } catch (error) {
    if (error?.code === "E_DB_CAPABILITIES_UNAVAILABLE") {
      return null;
    }
    throw error;
  }
}

function normalizeRuleset(input) {
  if (input === null || input === undefined) {
    return deepFreeze({
      path: null,
      ruleset: EMPTY_RULESET,
      hash: hashRuleset(EMPTY_RULESET)
    });
  }

  if (Array.isArray(input.rules)) {
    return deepFreeze({
      path: input.path ?? null,
      ruleset: input,
      hash: input.hash ?? hashRuleset(input)
    });
  }

  if (Array.isArray(input.ruleset?.rules)) {
    return deepFreeze({
      path: input.path ?? null,
      ruleset: input.ruleset,
      hash: input.hash ?? hashRuleset(input.ruleset)
    });
  }

  throw new TypeError("createDbHooks ruleset must be a ruleset, loaded ruleset, or null");
}

function runIdentity({ runId, ctx, op }) {
  const resolvedRunId = runId ?? ctx?.runId;
  const scenarioId = op?.scenarioId ?? ctx?.scenarioId;
  const surface = ctx?.surface ?? op?.surface ?? "db";

  if (typeof resolvedRunId !== "string" || resolvedRunId.length === 0) {
    throw new TypeError("createDbHooks requires a runId");
  }

  if (typeof scenarioId !== "string" || scenarioId.length === 0) {
    throw new TypeError("createDbHooks requires a scenarioId");
  }

  return Object.freeze({ runId: resolvedRunId, scenarioId, surface });
}

function resolveClient({ driver, config }) {
  if (config.client !== undefined) {
    return config.client;
  }

  if (typeof config.clientFor === "function") {
    return config.clientFor();
  }

  if (typeof driver.client === "function") {
    return driver.client();
  }

  if (driver.client !== undefined) {
    return driver.client;
  }

  if (typeof driver.getClient === "function") {
    return driver.getClient();
  }

  return null;
}

function assertClient(client) {
  if (client === null || typeof client !== "object" || typeof client.query !== "function") {
    throw new InfraError("E_DB_CLIENT_UNAVAILABLE", "Database hooks require access to the driver client.", {
      reason: "client_not_exposed"
    });
  }
}

function seedFor(op, config) {
  return op.seed ?? op.declaredSeed ?? config.seed ?? null;
}

function tenantEntities(config) {
  return config.tenant?.entities ?? config.tenantEntities ?? [];
}

function tenantColumn(config) {
  return config.tenant?.tenantColumn ?? config.tenantColumn ?? "tenant_key";
}

function registryTable(config) {
  return config.tenant?.registryTable ?? config.registryTable;
}

function rulesFromStats(ruleStats, health) {
  const dead = new Set(asArray(health?.dead).map((rule) => rule.ruleId ?? rule.id));
  const expired = new Set(asArray(health?.expired).map((rule) => rule.ruleId ?? rule.id));

  return deepFreeze(
    asArray(ruleStats).map((stat) => ({
      id: stat.id,
      kind: stat.kind,
      entity: stat.entity,
      suppressed: stat.suppressed ?? 0,
      overBudget: stat.overBudget ?? 0,
      cap: stat.cap ?? null,
      dead: dead.has(stat.id),
      expired: expired.has(stat.id)
    }))
  );
}

function quietPeriodFrom(closeResult) {
  if (!isPlainObject(closeResult?.quiet)) {
    return null;
  }

  return deepFreeze({
    quiet: closeResult.quiet.quiet === true,
    elapsedMs: closeResult.quiet.elapsedMs ?? 0,
    events: closeResult.quiet.events ?? 0,
    extensions: closeResult.quiet.extensions ?? 0
  });
}

function deltaForRecord({ deltaResult, closeResult, health }) {
  const quiet = quietPeriodFrom(closeResult);

  return deepFreeze({
    capturedEventCount: deltaResult.counts.total,
    counts: {
      expected: deltaResult.counts.expected,
      explained: deltaResult.counts.explained,
      suppressed_external: deltaResult.counts.suppressed_external,
      unexplained: deltaResult.counts.unexplained
    },
    unexplained: groupUnexplained(deltaResult.buckets.unexplained),
    shortfalls: deltaResult.expectationShortfalls,
    convergeMs: [closeResult?.converge?.elapsedMs ?? 0],
    quiet,
    quietPeriods: quiet === null ? [] : [quiet],
    rulesetHash: deltaResult.rulesetHash,
    rules: rulesFromStats(deltaResult.ruleStats, health),
    capViolations: deltaResult.capViolations,
    health: {
      dead: health.dead,
      expired: health.expired,
      expiringSoon: health.expiringSoon
    }
  });
}

function assertionOptions(op) {
  return Object.freeze({
    expectations: asArray(op.expect),
    requireNoUnexplained: op.requireNoUnexplained !== false
  });
}

function attachDelta(error, delta) {
  if (!(error instanceof AttestError)) {
    throw error;
  }

  throw new AttestError(error.code, error.message, {
    ...error.details,
    delta
  });
}

function inMemoryHealthStore() {
  let state = Object.freeze({ rules: Object.freeze({}) });

  return Object.freeze({
    async read() {
      return state;
    },
    async write(value) {
      state = deepFreeze(value);
    }
  });
}

function healthStoreFor(config) {
  if (config.ruleHealthStore !== undefined) {
    return config.ruleHealthStore;
  }

  if (config.ruleHealthPath === null) {
    return inMemoryHealthStore();
  }

  return createRuleHealthStore({ path: config.ruleHealthPath });
}

export function createDbHooks({ driver, ruleset = null, config = {}, runId } = {}) {
  assertImplementsDbPort(driver);
  const initialCapabilities = describeAtConstruction(driver);
  if (initialCapabilities !== null) {
    assertDeltaCapable(initialCapabilities);
  }

  const loadedRuleset = normalizeRuleset(ruleset);
  const healthStore = healthStoreFor(config);
  const state = {
    capabilities: initialCapabilities,
    preflightDone: false,
    tenant: null,
    client: null,
    windows: new Map(),
    tornDown: false
  };

  async function preflight({ signal, ctx } = {}) {
    throwIfAborted(signal, "E_DB_HOOK_PREFLIGHT_ABORTED", "Database hook preflight was aborted.");
    if (state.preflightDone) {
      return Object.freeze({ ok: true, capabilities: state.capabilities });
    }

    await driver.preflight({ signal, ctx });
    state.capabilities = driver.describeCapabilities();
    assertDeltaCapable(state.capabilities);
    state.preflightDone = true;
    state.tornDown = false;

    return Object.freeze({ ok: true, capabilities: state.capabilities });
  }

  async function onWindowOpen(op, { signal, ctx } = {}) {
    throwIfAborted(signal, "E_DB_WINDOW_OPEN_ABORTED", "Database window open was aborted.");
    await preflight({ signal, ctx });

    const identity = runIdentity({ runId, ctx, op });
    const client = resolveClient({ driver, config });
    assertClient(client);
    state.client = client;

    const tenantKey = tenantPrefixFor({
      ...identity,
      configuredPrefix: config.tenantPrefix ?? ctx?.tenantPrefix ?? "attest"
    });
    // Reclaim tenants a hard-killed run left behind, before provisioning this
    // one. The registry handles a Ctrl-C; nothing catches SIGKILL, so without
    // this the `attest_tenants` table grows a row per killed run forever and
    // the fixture data those rows point at is never deleted.
    //
    // Aged out at 24h and never touching this run's own key, so it can only
    // ever remove a tenant whose run is long gone.
    await sweepStaleTenants(client, {
      keep: [tenantKey, ...openTenantKeys()],
      registryTable: registryTable(config),
      tenantColumn: tenantColumn(config),
      entities: tenantEntities(config),
      now: ctx?.now ?? Date.now,
      signal,
      logger: ctx?.logger ?? config.logger
    }).catch(() => {
      // Best effort. A sweep that cannot run must not stop the run that is
      // trying to start: this reclaims yesterday's mess, it is not this run's
      // correctness.
    });

    state.tenant = await provisionTenant(client, {
      ...identity,
      tenantKey,
      tenantPrefix: tenantKey,
      tenantColumn: tenantColumn(config),
      registryTable: registryTable(config),
      entities: tenantEntities(config),
      metadata: { runId: identity.runId, scenarioId: identity.scenarioId, surface: identity.surface },
      now: ctx?.now ?? Date.now,
      signal
    });

    const seed = seedFor(op, config);
    if (seed !== null) {
      throwIfAborted(signal, "E_DB_SEED_ABORTED", "Database seed setup was aborted.");
      await applySeed(client, seed, { tenantKey });
      throwIfAborted(signal, "E_DB_PRESTATE_ABORTED", "Database pre state assertion was aborted.");
      await assertPreState(client, seed, { tenantKey });
    }

    const window = await driver.openWindow({ ...op, signal, ctx, tenant: state.tenant });
    state.windows.set(op.seq, window);
    return Object.freeze({ ok: true, tenant: state.tenant, window });
  }

  async function onWindowClose(op, { signal, ctx } = {}) {
    throwIfAborted(signal, "E_DB_WINDOW_CLOSE_ABORTED", "Database window close was aborted.");
    await preflight({ signal, ctx });

    const window = state.windows.get(op.seq) ?? null;
    const closeResult = await driver.closeWindow(window, { ...op, signal, ctx });
    state.windows.delete(op.seq);

    const options = assertionOptions(op);
    const compiled = compileRuleset({
      ruleset: loadedRuleset,
      dbCaps: state.capabilities,
      now: ctx?.now ?? Date.now,
      expectedMutations: options.expectations
    });
    const engine = createRuleEngine(compiled);
    const classified = classifyChanges({
      events: asArray(closeResult.events),
      expectations: options.expectations,
      engine,
      rulesetHash: loadedRuleset.hash
    });
    const capViolations = enforceCaps(classified.ruleStats);
    const health = await assessRuleHealth({
      ruleStats: classified.ruleStats,
      ruleset: loadedRuleset.ruleset,
      store: healthStore,
      now: ctx?.now ?? Date.now
    });
    const deltaResult = createDeltaResult({
      counts: classified.counts,
      buckets: classified.buckets,
      classifications: classified.classifications,
      ruleStats: classified.ruleStats,
      rulesetHash: loadedRuleset.hash,
      expectationShortfalls: classified.expectationShortfalls,
      capViolations,
      ruleHealth: health
    });
    const delta = deltaForRecord({ deltaResult, closeResult, health });

    try {
      assertDelta({
        deltaResult,
        expectations: options.expectations,
        requireNoUnexplained: options.requireNoUnexplained,
        capViolations,
        health,
        capabilities: state.capabilities
      });
    } catch (error) {
      attachDelta(error, delta);
    }

    return Object.freeze({ ok: true, delta });
  }

  async function teardown({ signal } = {}) {
    const errors = [];

    if (state.tenant !== null && state.client !== null) {
      try {
        await teardownTenant(state.client, {
          tenantKey: state.tenant.tenantKey,
          tenantColumn: tenantColumn(config),
          registryTable: registryTable(config),
          entities: tenantEntities(config),
          signal
        });
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await driver.teardown({ signal });
    } catch (error) {
      errors.push(error);
    }

    state.tenant = null;
    state.client = null;
    state.windows.clear();
    state.preflightDone = false;
    state.tornDown = true;

    if (errors.length > 0) {
      throw errors[0];
    }

    return Object.freeze({ ok: true });
  }

  return deepFreeze({
    preflight,
    onWindowOpen,
    onWindowClose,
    teardown,
    describeCapabilities() {
      return state.capabilities ?? driver.describeCapabilities();
    },
    get rulesetHash() {
      return loadedRuleset.hash;
    }
  });
}
