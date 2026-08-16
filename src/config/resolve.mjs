import { UsageError } from "../errors.mjs";
import { ConfigSchema, DEFAULTS } from "./schema.mjs";
import { resolveTarget } from "./targets.mjs";

const SECRET_KEY_RE = /(key|token|secret|password)/i;
const CREDENTIAL_URL_RE = /\b(?:postgres|mysql|mongodb):\/\//i;
const BEARER_RE = /\bBearer\s+\S+/i;
const HEX_BLOB_RE = /^[a-f0-9]{32,}$/i;
const BASE64_BLOB_RE = /^(?:[A-Za-z0-9+/]{32,}={0,2}|[A-Za-z0-9_-]{32,})$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}

function deepMerge(left, right) {
  if (!isRecord(right)) {
    return left;
  }

  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value === undefined) {
      continue;
    }
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function parseList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseBoolean(value, key) {
  if (/^(?:1|true|yes|on)$/i.test(value)) {
    return true;
  }
  if (/^(?:0|false|no|off)$/i.test(value)) {
    return false;
  }
  throw new UsageError("E_CONFIG_ENV_INVALID", `Environment variable ${key} must be boolean`, {
    key
  });
}

function parsePositiveInteger(value, key) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new UsageError("E_CONFIG_ENV_INVALID", `Environment variable ${key} must be a positive integer`, {
      key
    });
  }
  return parsed;
}

function envConfig(env = {}) {
  const config = {};
  const dbUrl = env.ATTEST_DB_URL;

  if (env.ATTEST_ARTIFACT_ROOT !== undefined) {
    config.artifactRoot = env.ATTEST_ARTIFACT_ROOT;
  }
  if (env.ATTEST_SCENARIOS !== undefined) {
    config.scenariosGlob = parseList(env.ATTEST_SCENARIOS);
  }
  if (env.ATTEST_BINDINGS !== undefined) {
    config.bindingsDir = env.ATTEST_BINDINGS;
  }
  if (env.ATTEST_APP !== undefined) {
    config.app = env.ATTEST_APP;
  }
  if (env.ATTEST_SURFACE !== undefined) {
    config.surfaces = parseList(env.ATTEST_SURFACE);
  }
  if (env.ATTEST_SURFACES !== undefined) {
    config.surfaces = parseList(env.ATTEST_SURFACES);
  }
  if (env.ATTEST_TIMEOUT_STEP_MS !== undefined) {
    config.timeouts = Object.assign(config.timeouts ?? {}, {
      stepMs: parsePositiveInteger(env.ATTEST_TIMEOUT_STEP_MS, "ATTEST_TIMEOUT_STEP_MS")
    });
  }
  if (env.ATTEST_TIMEOUT_SCENARIO_MS !== undefined) {
    config.timeouts = Object.assign(config.timeouts ?? {}, {
      scenarioMs: parsePositiveInteger(env.ATTEST_TIMEOUT_SCENARIO_MS, "ATTEST_TIMEOUT_SCENARIO_MS")
    });
  }
  if (env.ATTEST_FAIL_ON_SKIP !== undefined) {
    config.failOnSkip = parseBoolean(env.ATTEST_FAIL_ON_SKIP, "ATTEST_FAIL_ON_SKIP");
  }
  if (env.ATTEST_CONCURRENCY !== undefined) {
    config.concurrency = parsePositiveInteger(env.ATTEST_CONCURRENCY, "ATTEST_CONCURRENCY");
  }
  if (env.ATTEST_COLOR !== undefined) {
    config.color = parseBoolean(env.ATTEST_COLOR, "ATTEST_COLOR");
  }

  return Object.freeze({ config, dbUrl });
}

function secretReason(value, path) {
  if (typeof value !== "string") {
    return null;
  }

  if (CREDENTIAL_URL_RE.test(value)) {
    return "credential_url";
  }
  if (BEARER_RE.test(value)) {
    return "bearer_token";
  }
  if (SECRET_KEY_RE.test(path.at(-1) ?? "") && (HEX_BLOB_RE.test(value) || BASE64_BLOB_RE.test(value))) {
    return "secret_blob";
  }

  return null;
}

function assertNoFlagSecrets(value, path = []) {
  const reason = secretReason(value, path);
  if (reason !== null) {
    throw new UsageError("E_SECRET_IN_FLAG", "Secrets must not be passed as flags", {
      field: path.join("."),
      reason
    });
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoFlagSecrets(item, [...path, String(index)]));
    return;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertNoFlagSecrets(child, [...path, key]);
    }
  }
}

function schemaError(error) {
  return new UsageError("E_CONFIG_INVALID", "Configuration is invalid", {
    issues: error.issues.map((issue) => Object.freeze({ path: issue.path, message: issue.message }))
  });
}

export function resolveConfig({ defaults = DEFAULTS, file = {}, env = {}, flags = {} } = {}) {
  assertNoFlagSecrets(flags);

  const envLayer = envConfig(env);
  const merged = [defaults, file, envLayer.config, flags].reduce((current, layer) => deepMerge(current, layer), {});
  const parsed = ConfigSchema.safeParse(merged);

  if (!parsed.success) {
    throw schemaError(parsed.error);
  }

  const data = parsed.data;
  const target =
    envLayer.dbUrl === undefined
      ? null
      : resolveTarget({
          url: envLayer.dbUrl,
          allowlist: data.db?.allowlist ?? []
        });
  const db =
    data.db === null
      ? null
      : {
          ...data.db,
          target
        };

  return deepFreeze({ ...data, db });
}
