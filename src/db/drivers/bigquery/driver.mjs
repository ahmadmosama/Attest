import { InfraError, UnsupportedOpError, UsageError } from "../../../errors.mjs";
import { converge } from "../../../runtime/converge.mjs";
import { assertImplementsDbPort } from "../../port.mjs";
import { bigQueryCapabilities } from "./capabilities.mjs";

const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 1000;

// One gigabyte. Chosen to be obviously finite rather than obviously right: the
// point is that a number exists and a run cannot exceed it silently. An
// analytics dataset scanned nightly by accident is a real money leak.
export const DEFAULT_BYTE_BUDGET = 1_073_741_824;

function bytesRefusal(estimated, budget, sql) {
  return new UsageError("E_BIGQUERY_BYTE_BUDGET", "BigQuery query would scan more than the configured budget", {
    estimatedBytes: estimated,
    budgetBytes: budget,
    // The SQL is included because the operator has to be able to see what was
    // about to be paid for. It is harness authored, never user credentials.
    sql,
    remediation:
      "Narrow the query with a partition filter, or raise db.bigquery.byteBudget deliberately if the scan is genuinely intended."
  });
}

function optInRefusal() {
  return new UsageError("E_BIGQUERY_QUERY_NOT_ENABLED", "BigQuery querying is not enabled for this run", {
    remediation: "Set db.bigquery.allowQuery to true to let this run spend BigQuery scan budget."
  });
}

function assertTarget(target) {
  if (target?.driver !== "bigquery" || typeof target.host !== "string" || typeof target.database !== "string") {
    throw new UsageError("E_BIGQUERY_TARGET_INVALID", "BigQuery driver requires a bigquery://project/dataset target", {
      driver: target?.driver ?? null
    });
  }

  return Object.freeze({ project: target.host, dataset: target.database });
}

// Credentials come from Application Default Credentials or a service account
// path in the environment, and never from config, a target, or an artifact.
function credentialsPresent(env) {
  return (
    typeof env.GOOGLE_APPLICATION_CREDENTIALS === "string" && env.GOOGLE_APPLICATION_CREDENTIALS.length > 0
  ) || env.GOOGLE_CLOUD_PROJECT !== undefined || env.GCLOUD_PROJECT !== undefined;
}

function noCredentials() {
  return new InfraError("E_BIGQUERY_CREDENTIALS_MISSING", "No BigQuery credentials are available", {
    remediation:
      "Set GOOGLE_APPLICATION_CREDENTIALS to a service account key path, or run `gcloud auth application-default login`. Never put key material in the config or in a connection string."
  });
}

function captureUnsupported(operation) {
  // Returning an empty change list here would read as "nothing else changed",
  // which is exactly the claim BigQuery cannot make.
  return new UnsupportedOpError("E_DB_CAPTURE_UNSUPPORTED", `BigQuery has no change capture, so ${operation} cannot answer`, {
    driver: "bigquery",
    operation,
    supported: ["poll"],
    remediation: "Assert expected rows with bounded polling. A no unexplained delta assertion is refused at compile time."
  });
}

/**
 * The BigQuery driver.
 *
 * It does one thing: bounded polling for rows that should appear. Everything
 * else the port offers is refused by name rather than answered with an empty
 * result that would read as a clean bill of health.
 *
 * `query` and `dryRun` are injected, so the budget rule, the opt in and the
 * polling loop are all assertable with no credentials and no network. The real
 * client is wired in at the same seam.
 */
export function createBigQueryDriver({ target, config = {}, runId, scenarioId, dependencies = {}, env = process.env } = {}) {
  const location = assertTarget(target);
  const byteBudget = config.byteBudget ?? DEFAULT_BYTE_BUDGET;
  const allowQuery = config.allowQuery === true;
  const capabilities = bigQueryCapabilities();
  const state = { ready: false, window: null };

  async function guardedQuery(sql, params, { signal } = {}) {
    if (!allowQuery) {
      throw optInRefusal();
    }

    if (typeof dependencies.dryRun === "function") {
      const estimated = await dependencies.dryRun({ sql, params, signal, location });
      if (Number.isFinite(estimated) && estimated > byteBudget) {
        // A hard refusal, not a warning. A warning that is ignored still spends
        // the money.
        throw bytesRefusal(estimated, byteBudget, sql);
      }
    }

    if (typeof dependencies.query !== "function") {
      throw new InfraError("E_BIGQUERY_CLIENT_MISSING", "No BigQuery query client is wired in", {
        remediation:
          "Install and inject the BigQuery client. The driver keeps the client behind an injected seam so the budget and opt in rules stay testable without credentials."
      });
    }

    return dependencies.query({ sql, params, signal, location });
  }

  const driver = {
    describeCapabilities() {
      return capabilities;
    },

    async preflight(ctx = {}) {
      if (!credentialsPresent(ctx.env ?? env)) {
        throw noCredentials();
      }

      state.ready = true;
      return Object.freeze({ ok: true, capabilities });
    },

    async openWindow(ctx = {}) {
      const op = ctx.op ?? ctx;

      // There is no fence. watermarkFencing is "none" in the descriptor, and
      // this handle records only what the poll needs, so nothing downstream can
      // mistake it for a bounded window.
      state.window = Object.freeze({
        runId,
        scenarioId: op.scenarioId ?? scenarioId,
        surface: op.surface ?? config.surface ?? "db",
        seq: op.seq ?? 0,
        fenced: false
      });

      return state.window;
    },

    async closeWindow(windowHandle = null, ctx = {}) {
      const op = windowHandle?.kind === "db_window_close" ? windowHandle : ctx.op ?? ctx;

      if (op?.requireNoUnexplained === true) {
        // Belt and braces. The lowerer already refuses this at compile time
        // because the descriptor declares no delta assertion, so reaching here
        // means something bypassed compilation.
        throw new UnsupportedOpError("E_DELTA_UNSUPPORTED", "BigQuery cannot assert that nothing unexplained changed", {
          driver: "bigquery",
          flag: "delta_assertion",
          remediation: "Remove require_no_unexplained for this target. BigQuery supports expected row polling only."
        });
      }

      const expect = Array.isArray(op?.expect) ? op.expect : [];
      const polled = expect.length === 0 ? null : await driver.poll(state.window, { expect }, ctx);
      state.window = null;

      return Object.freeze({
        ok: polled === null ? true : polled.ok,
        // No events, and the reason is stated rather than left as an empty
        // array a reader could take for "nothing happened".
        events: Object.freeze([]),
        rows: polled === null ? Object.freeze([]) : polled.rows,
        harnessTxIds: Object.freeze([]),
        transactions: Object.freeze({}),
        warnings: capabilities.degraded,
        converge: polled?.converge ?? null,
        quiet: null
      });
    },

    onWindowOpen(op, options = {}) {
      return driver.openWindow({ ...options, op });
    },

    onWindowClose(op, options = {}) {
      return driver.closeWindow(op, options);
    },

    async drain() {
      throw captureUnsupported("drain");
    },

    async poll(_window, assertion = {}, options = {}) {
      const expect = Array.isArray(assertion.expect) ? assertion.expect : [];
      const signal = options.signal;
      let rows = Object.freeze([]);
      // converge treats a throwing probe as "not yet" and retries until the
      // timeout. A refused opt in or an exceeded byte budget will never become
      // true by waiting, so retrying one would burn the whole poll window and
      // then report a missed expectation, which is a failure about the wrong
      // thing entirely. Anything thrown here is carried out and rethrown.
      let fatal = null;

      const result = await converge({
        timeoutMs: assertion.timeoutMs ?? config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
        intervalMs: assertion.intervalMs ?? config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        signal,
        now: options.now ?? Date.now,
        probe: async () => {
          if (fatal !== null) {
            return Object.freeze({ ok: true });
          }

          try {
            const found = [];
            for (const expectation of expect) {
              const answered = await guardedQuery(expectation.sql, expectation.params ?? [], { signal });
              found.push(...(Array.isArray(answered) ? answered : answered?.rows ?? []));
            }
            rows = Object.freeze(found);
            return Object.freeze({ ok: found.length >= expect.length, value: rows });
          } catch (error) {
            fatal = error;
            // Satisfy convergence so it stops immediately rather than spending
            // the remaining timeout on a condition that cannot change.
            return Object.freeze({ ok: true });
          }
        }
      });

      if (fatal !== null) {
        throw fatal;
      }

      return Object.freeze({ ok: result.ok, rows, converge: result });
    },

    async teardown() {
      state.window = null;
      state.ready = false;
      return Object.freeze({ ok: true });
    }
  };

  assertImplementsDbPort(driver);
  return Object.freeze(driver);
}
