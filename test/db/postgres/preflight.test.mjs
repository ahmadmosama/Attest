import assert from "node:assert/strict";
import test from "node:test";

import { resolveTarget } from "../../../src/config/targets.mjs";
import { InfraError } from "../../../src/errors.mjs";
import {
  PG_TIMEOUTS,
  createPgClient,
  withClient,
  withFreshTransaction
} from "../../../src/db/drivers/postgres/connect.mjs";

// Postgres reports a whole number of seconds as "5s" and anything else in ms,
// so a configured 20000 comes back as "20s" and a configured 20500 as "20500ms".
function timeoutMatches(reported, expectedMs) {
  return reported === `${expectedMs}ms` || reported === `${expectedMs / 1000}s`;
}
import {
  PREFLIGHT_CHECKS,
  probeReplicaIdentity,
  runPreflight
} from "../../../src/db/drivers/postgres/preflight.mjs";
import { skipUnlessPostgres, withPostgresSlotLock } from "../../helpers/postgres.mjs";

const TARGET_URL = "postgres://postgres:secret@127.0.0.1:5432/postgres";
const TARGET = resolveTarget({
  url: TARGET_URL,
  allowlist: [
    {
      host: "127.0.0.1",
      database: "postgres",
      nonProd: true,
      note: "unit test target"
    }
  ]
});

function createPreflightClient({
  inRecovery = false,
  walLevel = "logical",
  rolreplication = true,
  rolsuper = false,
  usedSlots = 0,
  maxSlots = 4,
  identities = {}
} = {}) {
  return {
    queries: [],
    async query(text, values = []) {
      const sql = String(text);
      this.queries.push({ sql, values });

      if (sql.includes("pg_is_in_recovery")) {
        return { rows: [{ in_recovery: inRecovery }] };
      }

      if (sql.includes("SHOW wal_level")) {
        return { rows: [{ wal_level: walLevel }] };
      }

      if (sql.includes("FROM pg_roles")) {
        return { rows: [{ rolreplication, rolsuper }] };
      }

      if (sql.includes("FROM pg_replication_slots")) {
        return { rows: [{ used: usedSlots, maximum: maxSlots }] };
      }

      if (sql.includes("FROM pg_class")) {
        const key = `${values[0]}.${values[1]}`;
        return { rows: [{ relreplident: identities[key] ?? "d" }] };
      }

      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

function createFakeClientClass({ connectError = null, endError = null } = {}) {
  return class FakeClient {
    static instances = [];

    constructor(config) {
      this.config = config;
      this.queries = [];
      this.ended = false;
      FakeClient.instances.push(this);
    }

    async connect() {
      if (connectError !== null) {
        throw connectError;
      }
    }

    async query(sql) {
      this.queries.push(String(sql));
      return { rows: [] };
    }

    async end() {
      this.ended = true;
      if (endError !== null) {
        throw endError;
      }
    }
  };
}

test("PREFLIGHT_CHECKS names every Postgres capture gate check", () => {
  assert.deepEqual(PREFLIGHT_CHECKS, [
    "primary_target",
    "wal_level",
    "replication_privilege",
    "slot_capacity",
    "replica_identity"
  ]);
  assert.equal(Object.isFrozen(PREFLIGHT_CHECKS), true);
});

test("createPgClient refuses a raw connection string before pg sees it", async () => {
  await assert.rejects(
    () => createPgClient(TARGET_URL),
    /requires a resolved target/
  );
});

test("createPgClient pins session settings and keeps passwords out of serialization", async () => {
  const FakeClient = createFakeClientClass();
  const client = await createPgClient(TARGET, {
    ClientCtor: FakeClient,
    env: { ATTEST_DB_URL: TARGET_URL }
  });

  assert.equal(client.config.host, "127.0.0.1");
  assert.equal(client.config.database, "postgres");
  assert.equal(client.config.port, 5432);
  assert.equal(client.config.user, "postgres");
  assert.equal(client.config.password, "secret");
  assert.equal(JSON.stringify(client.config).includes("secret"), false);
  // The CONFIGURED guards, not a hardcoded 5000. The invariant is that a session
  // pins these instead of inheriting the server's defaults, which on a foreign
  // database could be anything at all including none. Hardcoding the number was
  // really asserting the developer's hardware, and it broke the moment CI told a
  // slower host about itself.
  assert.deepEqual(client.queries, [
    "SET application_name TO 'attest'",
    `SET statement_timeout TO '${PG_TIMEOUTS.statementMs}ms'`,
    `SET idle_in_transaction_session_timeout TO '${PG_TIMEOUTS.idleInTransactionMs}ms'`
  ]);
});

test("connection failure is an InfraError without credentials in details", async () => {
  const FakeClient = createFakeClientClass({ connectError: new Error("ECONNREFUSED") });

  await assert.rejects(
    () => createPgClient(TARGET, { ClientCtor: FakeClient, env: { ATTEST_DB_URL: TARGET_URL } }),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_DB_UNREACHABLE");
      assert.deepEqual(Object.keys(error.details).toSorted(), ["database", "host", "port"]);
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );
});

test("withClient releases the client and preserves body errors", async () => {
  const FakeClient = createFakeClientClass({ endError: new Error("close failed") });
  const original = new Error("body failed");

  await assert.rejects(
    () =>
      withClient(
        TARGET,
        () => {
          throw original;
        },
        { ClientCtor: FakeClient, env: { ATTEST_DB_URL: TARGET_URL } }
      ),
    (error) => error === original
  );
  assert.equal(FakeClient.instances[0].ended, true);
});

test("withFreshTransaction commits successful READ COMMITTED work", async () => {
  const client = {
    queries: [],
    async query(sql) {
      this.queries.push(String(sql));
      return { rows: [] };
    }
  };

  const result = await withFreshTransaction(client, () => "done");

  assert.equal(result, "done");
  assert.deepEqual(client.queries, [
    "BEGIN",
    "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "COMMIT"
  ]);
});

test("withFreshTransaction rolls back and propagates the original error", async () => {
  const original = new Error("poll failed");
  const client = {
    queries: [],
    async query(sql) {
      this.queries.push(String(sql));
      return { rows: [] };
    }
  };

  await assert.rejects(
    () =>
      withFreshTransaction(client, () => {
        throw original;
      }),
    (error) => error === original
  );
  assert.deepEqual(client.queries, [
    "BEGIN",
    "SET TRANSACTION ISOLATION LEVEL READ COMMITTED",
    "ROLLBACK"
  ]);
});

test("replica targets are refused because assertions must run on the primary", async () => {
  const client = createPreflightClient({ inRecovery: true });

  await assert.rejects(
    () => runPreflight({ target: TARGET, entities: [], client }),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_DB_REPLICA_TARGET");
      assert.match(error.message, /primary/);
      assert.deepEqual(error.details.host, "127.0.0.1");
      assert.equal(error.details.database, "postgres");
      assert.equal(error.details.port, 5432);
      assert.equal(JSON.stringify(error).includes("secret"), false);
      return true;
    }
  );
});

test("wal_level other than logical explicitly degrades delta capture", async () => {
  const result = await runPreflight({
    target: TARGET,
    entities: [],
    client: createPreflightClient({ walLevel: "replica" })
  });

  assert.equal(result.capabilities.capture, "none");
  assert.equal(result.capabilities.deltaAssertion, false);
  assert.equal(result.capabilities.beforeImages, "none");
  assert.match(result.capabilities.degraded.join("\n"), /wal_level/);
  assert.equal(
    result.checks.find((entry) => entry.name === "wal_level").status,
    "degrade"
  );
});

test("roles without replication privilege explicitly degrade delta capture", async () => {
  const result = await runPreflight({
    target: TARGET,
    entities: [],
    client: createPreflightClient({ rolreplication: false, rolsuper: false })
  });

  assert.equal(result.capabilities.capture, "none");
  assert.equal(result.capabilities.deltaAssertion, false);
  assert.match(result.capabilities.degraded.join("\n"), /rolreplication/);
  assert.equal(
    result.checks.find((entry) => entry.name === "replication_privilege").status,
    "degrade"
  );
});

test("fully consumed replication slots refuse with used and maximum counts", async () => {
  await assert.rejects(
    () =>
      runPreflight({
        target: TARGET,
        entities: [],
        client: createPreflightClient({ usedSlots: 2, maxSlots: 2 })
      }),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_DB_SLOT_LIMIT");
      assert.equal(error.details.used, 2);
      assert.equal(error.details.maximum, 2);
      return true;
    }
  );
});

test("probeReplicaIdentity maps f to full and d, i, n to key_only", async () => {
  const client = createPreflightClient({
    identities: {
      "public.full_table": "f",
      "public.default_table": "d",
      "public.index_table": "i",
      "public.nothing_table": "n"
    }
  });

  const result = await probeReplicaIdentity(client, [
    "public.full_table",
    "public.default_table",
    "public.index_table",
    "public.nothing_table"
  ]);

  assert.deepEqual(
    result.map((entry) => [entry.name, entry.relreplident, entry.beforeImages]),
    [
      ["public.full_table", "f", "full"],
      ["public.default_table", "d", "key_only"],
      ["public.index_table", "i", "key_only"],
      ["public.nothing_table", "n", "key_only"]
    ]
  );
});

test("tables without REPLICA IDENTITY FULL degrade before images by table name", async () => {
  const result = await runPreflight({
    target: TARGET,
    entities: ["public.orders", "public.users"],
    client: createPreflightClient({
      identities: {
        "public.orders": "d",
        "public.users": "f"
      }
    })
  });

  assert.equal(result.capabilities.capture, "logical_slot");
  assert.equal(result.capabilities.deltaAssertion, true);
  assert.equal(result.capabilities.beforeImages, "key_only");
  assert.match(result.capabilities.degraded.join("\n"), /public\.orders/);
  assert.doesNotMatch(result.capabilities.degraded.join("\n"), /public\.users/);
});

test("a healthy target produces the full logical slot descriptor", async () => {
  const result = await runPreflight({
    target: TARGET,
    entities: ["public.orders"],
    client: createPreflightClient({
      identities: {
        "public.orders": "f"
      }
    })
  });

  assert.equal(result.capabilities.capture, "logical_slot");
  assert.equal(result.capabilities.deltaAssertion, true);
  assert.equal(result.capabilities.boundedPolling, true);
  assert.equal(result.capabilities.beforeImages, "full");
  assert.equal(result.capabilities.ordering, true);
  assert.equal(result.capabilities.txAttribution, true);
  assert.equal(result.capabilities.watermarkFencing, "inline");
  assert.equal(result.capabilities.transactionalTeardown, true);
  assert.deepEqual(result.capabilities.degraded, []);
});

test("live Postgres connection pins session settings and transaction isolation", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await withPostgresSlotLock(live, async () => {
    await withClient(live.target, async (client) => {
      const settings = await client.query(`
        SELECT
          current_setting('application_name') AS application_name,
          current_setting('statement_timeout') AS statement_timeout,
          current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout
      `);

      assert.equal(settings.rows[0].application_name, "attest");
      // Postgres renders a whole number of seconds as "5s" and anything else in
      // ms, so both spellings of the configured value are accepted.
      assert.ok(
        timeoutMatches(settings.rows[0].statement_timeout, PG_TIMEOUTS.statementMs),
        `statement_timeout was ${settings.rows[0].statement_timeout}, expected ${PG_TIMEOUTS.statementMs}ms`
      );
      assert.ok(
        timeoutMatches(
          settings.rows[0].idle_in_transaction_session_timeout,
          PG_TIMEOUTS.idleInTransactionMs
        ),
        `idle_in_transaction_session_timeout was ${settings.rows[0].idle_in_transaction_session_timeout}`
      );

      await withFreshTransaction(client, async (txClient) => {
        const isolation = await txClient.query("SHOW transaction_isolation");
        assert.equal(isolation.rows[0].transaction_isolation, "read committed");
      });
    });
  });
});

test("live Postgres preflight reflects the actual server", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await withPostgresSlotLock(live, async () => {
    const tableName = `attest_preflight_identity_${process.pid}_${Date.now()}`;

    await withClient(live.target, async (client) => {
      try {
        await client.query(`CREATE TABLE ${tableName} (id integer PRIMARY KEY, name text)`);
        await client.query(`ALTER TABLE ${tableName} REPLICA IDENTITY FULL`);

        const result = await runPreflight({
          target: live.target,
          entities: [`public.${tableName}`]
        });

        assert.equal(result.findings.inRecovery, false);
        assert.equal(result.findings.walLevel, "logical");
        assert.equal(result.capabilities.capture, "logical_slot");
        assert.equal(result.capabilities.deltaAssertion, true);
        assert.equal(result.capabilities.beforeImages, "full");
        assert.equal(result.capabilities.ordering, true);
        assert.equal(result.capabilities.txAttribution, true);
        assert.equal(result.capabilities.watermarkFencing, "inline");
        assert.equal(result.capabilities.transactionalTeardown, true);
      } finally {
        await client.query(`DROP TABLE IF EXISTS ${tableName}`);
      }
    });
  });
});
