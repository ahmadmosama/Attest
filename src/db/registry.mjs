import { UsageError } from "../errors.mjs";
import { createPgClient } from "./drivers/postgres/connect.mjs";
import { createPostgresDriver } from "./drivers/postgres/driver.mjs";

const DRIVER_NAMES = Object.freeze(["postgres", "sqlite", "mysql", "mongo", "bigquery"]);
const IMPLEMENTED = "implemented";
const PLANNED = "planned";

export const DB_DRIVER_MODES = Object.freeze({
  postgres: IMPLEMENTED,
  sqlite: PLANNED,
  mysql: PLANNED,
  mongo: PLANNED,
  bigquery: PLANNED
});

const DRIVER_SET = new Set(DRIVER_NAMES);

function driverName(target) {
  return typeof target?.driver === "string" ? target.driver : null;
}

function acceptedDrivers() {
  return Object.freeze([...DRIVER_NAMES]);
}

function unknownDriverError(driver) {
  return new UsageError(
    "E_DB_DRIVER_UNKNOWN",
    "Database driver must be one of the accepted drivers.",
    {
      driver,
      accepted: acceptedDrivers()
    }
  );
}

function plannedDriverError(driver) {
  return new UsageError(
    "E_DB_DRIVER_NOT_IMPLEMENTED",
    `Database driver ${driver} is declared but not implemented until Phase 6.`,
    {
      driver,
      status: PLANNED,
      roadmapPhase: "Phase 6",
      remediation: "Use postgres for Phase 3 database delta runs, or wait for the Phase 6 driver release."
    }
  );
}

function assertTarget(target) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    throw new TypeError("createDbDriver requires a resolved database target");
  }
}

function postgresConfig(config, surface) {
  if (surface === undefined || surface === null) {
    return config;
  }

  return Object.freeze({
    ...config,
    surface
  });
}

function postgresDependencies(config) {
  let activeClient = null;
  const base = config?.dependencies?.createPgClient ?? createPgClient;
  const dependencies = Object.freeze({
    ...config?.dependencies,
    async createPgClient(...args) {
      const client = await base(...args);
      if (activeClient === null) {
        activeClient = client;
      }
      return client;
    }
  });

  return Object.freeze({
    dependencies,
    client() {
      return activeClient;
    }
  });
}

function createPostgres({ target, config, runId, scenarioId, surface }) {
  const tracked = postgresDependencies(config);
  const driver = createPostgresDriver({
    target,
    config: postgresConfig(config, surface),
    runId,
    scenarioId,
    dependencies: tracked.dependencies
  });

  return Object.freeze({
    ...driver,
    client: tracked.client
  });
}

function createPlanned(driver) {
  throw plannedDriverError(driver);
}

export function createDbDriver({
  target,
  config = {},
  runId,
  scenarioId,
  surface
} = {}) {
  assertTarget(target);

  const driver = driverName(target);
  if (driver === "postgresql") {
    return createPostgres({ target, config, runId, scenarioId, surface });
  }

  if (!DRIVER_SET.has(driver)) {
    throw unknownDriverError(driver);
  }

  if (DB_DRIVER_MODES[driver] === PLANNED) {
    return createPlanned(driver);
  }

  if (driver === "postgres") {
    return createPostgres({ target, config, runId, scenarioId, surface });
  }

  throw unknownDriverError(driver);
}
