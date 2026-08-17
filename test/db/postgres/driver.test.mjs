import assert from "node:assert/strict";
import test from "node:test";

import { defineDbCapabilities } from "../../../src/capabilities/db-caps.mjs";
import { assertImplementsDbPort } from "../../../src/db/port.mjs";
import { createLogicalSlotCapture } from "../../../src/db/capture/logical-slot.mjs";
import { createPostgresDriver } from "../../../src/db/drivers/postgres/driver.mjs";
import { withClient } from "../../../src/db/drivers/postgres/connect.mjs";
import {
  createSlot,
  dropSlot,
  slotNameFor
} from "../../../src/db/drivers/postgres/slots.mjs";
import { InfraError, UnsupportedOpError } from "../../../src/errors.mjs";
import { classifyError } from "../../../src/runtime/classify.mjs";
import { skipUnlessPostgres, withPostgresSlotLock } from "../../helpers/postgres.mjs";

function target() {
  return Object.freeze({
    driver: "postgres",
    host: "127.0.0.1",
    port: 5432,
    database: "postgres",
    user: "postgres"
  });
}

function fullCapabilities() {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true,
    beforeImages: "full",
    degraded: []
  });
}

function fakeClient(calls) {
  return {
    ended: false,
    async query() {
      return { rows: [] };
    },
    async end() {
      calls.push("end");
      this.ended = true;
    }
  };
}

function baseDependencies(calls, overrides = {}) {
  const client = fakeClient(calls);

  return {
    client,
    deps: {
      async runPreflight() {
        calls.push("gate");
        return {
          ok: true,
          capabilities: fullCapabilities(),
          findings: {},
          checks: []
        };
      },
      selectCaptureStrategy(capabilities) {
        calls.push(`select:${capabilities.capture}`);
        return { name: "logical_slot" };
      },
      slotNameFor() {
        calls.push("name");
        return slotNameFor({ runId: "driver", scenarioId: "unit" });
      },
      async createPgClient() {
        calls.push("connect");
        return client;
      },
      async sweepOrphanSlots() {
        calls.push("sweep");
        return [];
      },
      async createSlot() {
        calls.push("create");
        return { slotName: slotNameFor({ runId: "driver", scenarioId: "unit" }), warnings: [] };
      },
      async dropSlot() {
        calls.push("drop");
        return { dropped: true };
      },
      createLogicalSlotCapture() {
        calls.push("capture");
        return {
          async drain() {
            calls.push("drain");
            return {
              events: [
                Object.freeze({
                  entity: "public.orders",
                  key: Object.freeze({ id: 1 }),
                  op: "insert",
                  paths: Object.freeze([Object.freeze(["id"])]),
                  before: null,
                  after: Object.freeze({ id: 1 }),
                  txId: "10",
                  seq: 0,
                  actor: Object.freeze({ kind: "unknown", lsn: "0/1" }),
                  fidelity: "value_only"
                })
              ],
              transactions: {},
              warnings: [],
              more: false
            };
          }
        };
      },
      ...overrides
    }
  };
}

async function liveSlotNames(client) {
  const result = await client.query(
    "SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE 'attest\\_%' ESCAPE '\\' ORDER BY slot_name"
  );
  return result.rows.map((row) => row.slot_name);
}

function uniqueName(label) {
  return `attest_${label}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`.toLowerCase();
}

test("createPostgresDriver satisfies the frozen database port without changing its shape", () => {
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario"
  });

  assert.doesNotThrow(() => assertImplementsDbPort(driver));
});

test("describeCapabilities raises before preflight instead of guessing", () => {
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario"
  });

  assert.throws(
    () => driver.describeCapabilities(),
    (error) => {
      assert.equal(error.code, "E_DB_CAPABILITIES_UNAVAILABLE");
      return true;
    }
  );
});

test("driver preflight gates, sweeps orphans, creates this scenario slot, and exposes capabilities", async () => {
  const calls = [];
  const { deps } = baseDependencies(calls);
  const driver = createPostgresDriver({
    target: target(),
    config: { entities: ["public.orders"] },
    runId: "run",
    scenarioId: "scenario",
    dependencies: deps
  });

  const result = await driver.preflight();

  assert.deepEqual(result, { ok: true });
  assert.equal(driver.describeCapabilities().capture, "logical_slot");
  assert.deepEqual(calls, ["gate", "select:logical_slot", "name", "connect", "sweep", "create", "capture"]);
  assert(calls.indexOf("gate") < calls.indexOf("sweep"));
  assert(calls.indexOf("sweep") < calls.indexOf("create"));
});

test("preflight failure after slot creation drops the slot before propagating", async () => {
  const calls = [];
  const { deps } = baseDependencies(calls, {
    createLogicalSlotCapture() {
      calls.push("capture");
      throw new Error("capture construction failed");
    }
  });
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario",
    dependencies: deps
  });

  await assert.rejects(() => driver.preflight(), /capture construction failed/u);
  assert.deepEqual(calls, ["gate", "select:logical_slot", "name", "connect", "sweep", "create", "capture", "drop", "end"]);
});

test("capability refusal is reported as infra and does not create a slot", async () => {
  const calls = [];
  const { deps } = baseDependencies(calls, {
    selectCaptureStrategy() {
      calls.push("select:none");
      throw new Error("no logical capture");
    }
  });
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario",
    dependencies: deps
  });

  await assert.rejects(
    () => driver.preflight(),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_DB_CAPTURE_UNSUPPORTED");
      assert.equal(classifyError(error).result, "infra_error");
      return true;
    }
  );
  assert.deepEqual(calls, ["gate", "select:none"]);
});

test("unreachable database errors remain infra errors", async () => {
  const calls = [];
  const unreachable = new InfraError("E_DB_UNREACHABLE", "unreachable", {
    host: "127.0.0.1",
    database: "postgres",
    port: 1
  });
  const { deps } = baseDependencies(calls, {
    async runPreflight() {
      calls.push("gate");
      throw unreachable;
    }
  });
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario",
    dependencies: deps
  });

  await assert.rejects(() => driver.preflight(), (error) => error === unreachable);
  assert.equal(classifyError(unreachable).result, "infra_error");
  assert.deepEqual(calls, ["gate"]);
});

test("teardown is idempotent and safe after partial setup", async () => {
  const calls = [];
  const { deps } = baseDependencies(calls);
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario",
    dependencies: deps
  });

  await driver.teardown();
  await driver.preflight();
  await driver.teardown();
  await driver.teardown();

  assert.deepEqual(calls, ["gate", "select:logical_slot", "name", "connect", "sweep", "create", "capture", "drop", "end"]);
});

test("openWindow, closeWindow, and poll expose the Phase 03-11 not implemented seam", async () => {
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario"
  });

  for (const call of [
    () => driver.openWindow(),
    () => driver.closeWindow({}),
    () => driver.poll({}, {}, {})
  ]) {
    await assert.rejects(
      call,
      (error) => {
        assert(error instanceof UnsupportedOpError);
        assert.equal(error.code, "E_NOT_IMPLEMENTED");
        assert.equal(error.details.plannedPhase, "03-11");
        return true;
      }
    );
  }
});

test("driver methods honor already aborted signals", async () => {
  const calls = [];
  const { deps } = baseDependencies(calls);
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario",
    dependencies: deps
  });
  const controller = new AbortController();
  controller.abort(new Error("timeout"));

  await assert.rejects(
    () => driver.preflight({ signal: controller.signal }),
    (error) => {
      assert(error instanceof InfraError);
      assert.equal(error.code, "E_DB_PREFLIGHT_ABORTED");
      return true;
    }
  );
  await assert.rejects(() => driver.openWindow({ signal: controller.signal }), /aborted/u);
  await assert.rejects(() => driver.closeWindow({}, { signal: controller.signal }), /aborted/u);
  await assert.rejects(() => driver.poll({}, {}, { signal: controller.signal }), /aborted/u);
  assert.deepEqual(calls, []);
});

test("driver drain returns ChangeEvents from the logical capture strategy", async () => {
  const calls = [];
  const { deps } = baseDependencies(calls);
  const driver = createPostgresDriver({
    target: target(),
    runId: "run",
    scenarioId: "scenario",
    dependencies: deps
  });

  await driver.preflight();
  const events = await driver.drain({});

  assert.equal(events.length, 1);
  assert.equal(events[0].entity, "public.orders");
  assert.equal(events[0].txId, "10");
  assert.deepEqual(calls.slice(-1), ["drain"]);
});

test("logical slot capture drains through parseSlotRows, consumes batches, rebases seq, and surfaces warnings", async () => {
  const client = {
    queries: [],
    async query(sql) {
      this.queries.push(String(sql));
      return { rows: [] };
    }
  };
  const responses = [
    {
      rows: [
        { lsn: "0/1", xid: "10", data: "BEGIN 10" },
        { lsn: "0/2", xid: "10", data: "table public.orders: INSERT: id[integer]:1 name[text]:'first'" },
        { lsn: "0/3", xid: "10", data: "COMMIT 10" }
      ],
      more: false
    },
    {
      rows: [
        { lsn: "0/4", xid: "11", data: "BEGIN 11" },
        { lsn: "0/5", xid: "11", data: "table public.orders: DELETE: (no-tuple-data)" },
        { lsn: "0/6", xid: "11", data: "COMMIT 11" }
      ],
      more: true
    },
    {
      rows: [],
      more: false
    }
  ];
  const capture = createLogicalSlotCapture({
    client,
    slotName: slotNameFor({ runId: "capture", scenarioId: "unit" }),
    keyColumns: { "public.orders": ["id"] },
    batchSize: 2,
    drainSlotImpl: async () => responses.shift()
  });

  const first = await capture.drain();
  const second = await capture.drain();
  const third = await capture.drain();

  assert.deepEqual(first.events.map((event) => event.seq), [0]);
  assert.deepEqual(second.events.map((event) => event.seq), [1]);
  assert.equal(second.more, true);
  assert.equal(second.warnings[0].code, "W_DB_DELETE_NO_TUPLE_DATA");
  assert.deepEqual(third.events, []);
  assert.equal(client.queries.includes("BEGIN"), false);
});

test("live logical slot capture consumes changes and an empty second drain returns no events", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await withPostgresSlotLock(live, async () => {
    const tableName = uniqueName("capture");
    const slotName = slotNameFor({
      runId: `live_${process.pid}_${Date.now()}`,
      scenarioId: tableName
    });

    await withClient(live.target, async (client) => {
      try {
        await client.query(`CREATE TABLE ${tableName} (id integer PRIMARY KEY, name text)`);
        await client.query(`ALTER TABLE ${tableName} REPLICA IDENTITY FULL`);
        await createSlot(client, slotName);

        const capture = createLogicalSlotCapture({
          client,
          slotName,
          keyColumns: { [`public.${tableName}`]: ["id"] },
          batchSize: 100
        });

        await client.query(`INSERT INTO ${tableName} (id, name) VALUES (1, 'first')`);
        const first = await capture.drain();
        const second = await capture.drain();

        assert.deepEqual(first.events.map((event) => event.entity), [`public.${tableName}`]);
        assert.deepEqual(first.events.map((event) => event.seq), [0]);
        assert.equal(first.events[0].txId !== null, true);
        assert.deepEqual(second.events, []);
        assert.equal(second.more, false);
      } finally {
        await dropSlot(client, slotName);
        await client.query(`DROP TABLE IF EXISTS ${tableName}`);
        assert.equal((await liveSlotNames(client)).includes(slotName), false);
      }
    });
  });
});
