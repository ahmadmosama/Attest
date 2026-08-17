import { UsageError } from "../errors.mjs";
import { createPgClient } from "./drivers/postgres/connect.mjs";
import { createPostgresDriver } from "./drivers/postgres/driver.mjs";
import { createBigQueryDriver } from "./drivers/bigquery/driver.mjs";
import { createMongoDriver } from "./drivers/mongo/driver.mjs";
import { createMysqlDriver } from "./drivers/mysql/driver.mjs";
import { createSqliteDriver } from "./drivers/sqlite/driver.mjs";

const DRIVER_NAMES = Object.freeze(["postgres", "sqlite", "mysql", "mongo", "bigquery"]);
const IMPLEMENTED = "implemented";
const PLANNED = "planned";

export const DB_DRIVER_MODES = Object.freeze({
  postgres: IMPLEMENTED,
  sqlite: IMPLEMENTED,
  mysql: IMPLEMENTED,
  mongo: IMPLEMENTED,
  bigquery: IMPLEMENTED
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

// Every declared engine is implemented. The map is kept because the registry
// test requires a mode for each, so an engine cannot be added without one.
const PLANNED_BY = Object.freeze({});

function plannedDriverError(driver) {
  return new UsageError(
    "E_DB_DRIVER_NOT_IMPLEMENTED",
    `Database driver ${driver} is declared but not implemented yet.`,
    {
      driver,
      status: PLANNED,
      roadmapPhase: "Phase 6",
      plan: PLANNED_BY[driver] ?? null,
      remediation: `Use postgres for database delta runs until the ${driver} driver lands in Phase 6 plan ${PLANNED_BY[driver] ?? "TBD"}.`
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

  // `postgresql` is accepted because a target can still arrive from a caller
  // that did not go through resolveTarget, which normalises the alias.
  const driver = driverName(target) === "postgresql" ? "postgres" : driverName(target);

  if (!DRIVER_SET.has(driver)) {
    throw unknownDriverError(driver);
  }

  if (DB_DRIVER_MODES[driver] === PLANNED) {
    return createPlanned(driver);
  }

  if (driver === "postgres") {
    return createPostgres({ target, config, runId, scenarioId, surface });
  }

  if (driver === "sqlite") {
    return createSqliteDriver({
      target,
      config: postgresConfig(config, surface),
      runId,
      scenarioId,
      dependencies: config?.dependencies
    });
  }

  if (driver === "mysql") {
    return createMysqlDriver({
      target,
      config: postgresConfig(config, surface),
      runId,
      scenarioId,
      dependencies: config?.dependencies
    });
  }

  if (driver === "mongo") {
    return createMongoDriver({
      target,
      config: postgresConfig(config, surface),
      runId,
      scenarioId,
      dependencies: config?.dependencies
    });
  }

  if (driver === "bigquery") {
    return createBigQueryDriver({
      target,
      config: postgresConfig(config, surface),
      runId,
      scenarioId,
      dependencies: config?.dependencies
    });
  }

  throw unknownDriverError(driver);
}
