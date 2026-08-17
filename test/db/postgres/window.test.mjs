import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { createLogicalSlotCapture } from "../../../src/db/capture/logical-slot.mjs";
import { createPgClient, withClient } from "../../../src/db/drivers/postgres/connect.mjs";
import {
  closePostgresWindow,
  openPostgresWindow
} from "../../../src/db/drivers/postgres/window.mjs";
import {
  createSlot,
  dropSlot,
  slotNameFor
} from "../../../src/db/drivers/postgres/slots.mjs";
import { WATERMARK_ENTITY } from "../../../src/db/watermark.mjs";
import { skipUnlessPostgres, withPostgresSlotLock } from "../../helpers/postgres.mjs";

function appEvent({ seq, txId = `app-${seq}`, after = { id: seq } } = {}) {
  return Object.freeze({
    entity: "public.orders",
    key: Object.freeze({ id: after.id }),
    op: "insert",
    paths: Object.freeze([Object.freeze(["id"])]),
    before: null,
    after: Object.freeze(after),
    txId,
    seq,
    actor: Object.freeze({ kind: "unknown" }),
    fidelity: "value_only"
  });
}

function markerEvent({ boundary, seq, txId, nonce = "nonce" }) {
  return Object.freeze({
    entity: WATERMARK_ENTITY,
    key: Object.freeze({}),
    op: "insert",
    paths: Object.freeze([Object.freeze(["boundary"])]),
    before: null,
    after: Object.freeze({
      run_id: "run",
      scenario_id: "scenario.one",
      surface: "web",
      seq: 1,
      nonce,
      boundary
    }),
    txId,
    seq,
    actor: Object.freeze({ kind: "unknown" }),
    fidelity: "value_only"
  });
}

function markerClient(calls) {
  return {
    async query(text, values = []) {
      const normalized = String(text).trim().split(/\s+/u).slice(0, 3).join(" ");
      calls.push(`marker:${normalized}`);
      return { rows: [], values };
    }
  };
}

function pollClient(calls, { abort } = {}) {
  return {
    async query(text) {
      const normalized = String(text).trim().split(/\s+/u).slice(0, 3).join(" ");
      calls.push(`poll:${normalized}`);
      if (/SELECT COUNT/u.test(String(text))) {
        if (typeof abort === "function") {
          abort();
        }
        return { rows: [{ count: 1 }] };
      }
      return { rows: [] };
    },
    async end() {
      calls.push("poll:end");
    }
  };
}

function captureFrom(batches, calls) {
  const remaining = batches.slice();

  return Object.freeze({
    async drain() {
      calls.push("capture:drain");
      const events = remaining.shift() ?? [];
      return Object.freeze({
        events: Object.freeze(events),
        transactions: Object.freeze({}),
        warnings: Object.freeze([]),
        more: false
      });
    }
  });
}

function uniqueName(label) {
  return `attest_${label}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 100000)}`.toLowerCase();
}

async function liveSlotNames(client) {
  const result = await client.query(
    "SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE 'attest\\_%' ESCAPE '\\' ORDER BY slot_name"
  );
  return result.rows.map((row) => row.slot_name);
}

test("openPostgresWindow writes an open marker and returns the capture handle identity", async () => {
  const calls = [];
  const capture = captureFrom([], calls);
  const result = await openPostgresWindow({
    client: markerClient(calls),
    capture,
    runId: "run",
    scenarioId: "scenario.one",
    surface: "web",
    seq: 1,
    nonce: "nonce"
  });

  assert.equal(result.nonce, "nonce");
  assert.equal(result.capture, capture);
  assert.equal(calls.includes("marker:CREATE SCHEMA IF"), true);
  assert.equal(calls.includes("marker:INSERT INTO attest.watermark"), true);
  assert(calls.indexOf("marker:INSERT INTO attest.watermark") < calls.indexOf("marker:COMMIT"));
});

test("closePostgresWindow writes close before convergence, drains quiet, and slices markers out", async () => {
  const calls = [];
  const open = markerEvent({ boundary: "open", seq: 0, txId: "h-open" });
  const expected = appEvent({ seq: 1, txId: "app-1", after: { id: 1, status: "paid" } });
  const late = appEvent({ seq: 2, txId: "app-2", after: { id: 2, status: "audit" } });
  const close = markerEvent({ boundary: "close", seq: 3, txId: "h-close" });
  const capture = captureFrom([[open, expected], [late, close], []], calls);

  const result = await closePostgresWindow({
    client: markerClient(calls),
    pollClient: pollClient(calls),
    capture,
    runId: "run",
    scenarioId: "scenario.one",
    surface: "web",
    seq: 1,
    nonce: "nonce",
    expect: [{ entity: "orders", op: "insert", count: 1, where: { status: "paid" } }],
    convergeTimeoutMs: 25,
    quietPeriodMs: 5,
    quietPeriodCapMs: 250
  });

  assert.deepEqual(result.events, [expected, late]);
  assert.deepEqual(result.harnessTxIds, ["h-open", "h-close"]);
  assert.equal(result.converge.ok, true);
  assert.equal(result.quiet.quiet, true);
  assert.equal(result.quiet.events, 4);
  assert(calls.indexOf("marker:INSERT INTO attest.watermark") < calls.indexOf("poll:BEGIN"));
  assert.equal(calls.at(-1), "poll:end");
});

test("closePostgresWindow records a convergence miss instead of throwing", async () => {
  const calls = [];
  const result = await closePostgresWindow({
    client: markerClient(calls),
    pollClient: {
      async query(text) {
        calls.push(String(text).trim().split(/\s+/u)[0]);
        if (/SELECT COUNT/u.test(String(text))) {
          return { rows: [{ count: 0 }] };
        }
        return { rows: [] };
      },
      async end() {
        calls.push("end");
      }
    },
    capture: captureFrom(
      [[markerEvent({ boundary: "open", seq: 0, txId: "h-open" }), markerEvent({ boundary: "close", seq: 1, txId: "h-close" })], []],
      calls
    ),
    runId: "run",
    scenarioId: "scenario.one",
    surface: "web",
    seq: 1,
    nonce: "nonce",
    expect: [{ entity: "orders", op: "insert", count: 1, where: { status: "missing" } }],
    convergeTimeoutMs: 1,
    quietPeriodMs: 5,
    quietPeriodCapMs: 250
  });

  assert.equal(result.converge.ok, false);
  assert.equal(result.events.length, 0);
});

test("an abort during convergence propagates after the close marker and releases the poll client", async () => {
  const calls = [];
  const controller = new AbortController();

  await assert.rejects(
    () =>
      closePostgresWindow({
        client: markerClient(calls),
        pollClient: pollClient(calls, {
          abort() {
            controller.abort(new Error("stop"));
          }
        }),
        capture: captureFrom([], calls),
        runId: "run",
        scenarioId: "scenario.one",
        surface: "web",
        seq: 1,
        nonce: "nonce",
        expect: [{ entity: "orders", op: "insert", count: 1, where: { status: "paid" } }],
        convergeTimeoutMs: 25,
        quietPeriodMs: 1,
        quietPeriodCapMs: 10,
        signal: controller.signal
      }),
    /stop/u
  );

  assert(calls.indexOf("marker:INSERT INTO attest.watermark") < calls.indexOf("poll:BEGIN"));
  assert.equal(calls.at(-1), "poll:end");
});

test("live Postgres window excludes outside writes and includes inside writes", async (t) => {
  const live = await skipUnlessPostgres(t);
  if (live === null) {
    return;
  }

  await withPostgresSlotLock(live, async () => {
    const tableName = uniqueName("window");
    const slotName = slotNameFor({
      runId: `window_${process.pid}_${Date.now()}`,
      scenarioId: tableName
    });

    await withClient(live.target, async (client) => {
      try {
        await client.query(`CREATE TABLE ${tableName} (id integer PRIMARY KEY, status text NOT NULL)`);
        await client.query(`ALTER TABLE ${tableName} REPLICA IDENTITY FULL`);
        await createSlot(client, slotName);

        const capture = createLogicalSlotCapture({
          client,
          slotName,
          keyColumns: {
            [`public.${tableName}`]: ["id"],
            [WATERMARK_ENTITY]: ["run_id", "scenario_id", "surface", "seq", "nonce", "boundary"]
          },
          batchSize: 100
        });

        await client.query(`INSERT INTO ${tableName} (id, status) VALUES (1, 'outside_before')`);
        const window = await openPostgresWindow({
          client,
          capture,
          runId: "run",
          scenarioId: "scenario.one",
          surface: "web",
          seq: 1,
          nonce: "live-nonce"
        });
        await client.query(`INSERT INTO ${tableName} (id, status) VALUES (2, 'inside')`);

        await withClient(live.target, async (writer) => {
          await delay(300);
          await writer.query(`INSERT INTO ${tableName} (id, status) VALUES (3, 'late_inside')`);
        });

        const result = await closePostgresWindow({
          client,
          createPollClient: ({ signal }) => createPgClient(live.target, { signal }),
          capture,
          runId: "run",
          scenarioId: "scenario.one",
          surface: "web",
          seq: 1,
          nonce: window.nonce,
          expect: [{ entity: tableName, op: "insert", count: 1, where: { status: "inside" } }],
          convergeTimeoutMs: 1000,
          quietPeriodMs: 25,
          quietPeriodCapMs: 250
        });

        const statuses = result.events
          .filter((change) => change.entity === `public.${tableName}`)
          .map((change) => change.after.status)
          .toSorted();

        assert.deepEqual(statuses, ["inside", "late_inside"]);
        assert.equal(result.events.some((change) => change.after?.status === "outside_before"), false);
        assert.equal(result.events.some((change) => change.entity === WATERMARK_ENTITY), false);
      } finally {
        await dropSlot(client, slotName);
        await client.query(`DROP TABLE IF EXISTS ${tableName}`);
        await client.query(
          "DELETE FROM attest.watermark WHERE run_id = $1 AND scenario_id = $2",
          ["run", "scenario.one"]
        );
        assert.equal((await liveSlotNames(client)).includes(slotName), false);
      }
    });
  });
});
