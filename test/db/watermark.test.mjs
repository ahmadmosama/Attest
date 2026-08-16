import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureWatermarkTable,
  sliceWindow,
  WATERMARK_ENTITY,
  writeMarker
} from "../../src/db/watermark.mjs";

function clientFor({ failInsert = false } = {}) {
  const queries = [];

  return {
    queries,
    async query(text, values = []) {
      queries.push({ text: String(text), values });
      if (failInsert && String(text).includes("INSERT INTO attest.watermark")) {
        throw new Error("duplicate marker");
      }
      return { rows: [] };
    }
  };
}

function event({ entity = "public.orders", op = "insert", seq, txId = "app", after = {} }) {
  return Object.freeze({
    entity,
    key: Object.freeze({ id: seq }),
    op,
    paths: Object.freeze([Object.freeze(["id"])]),
    before: null,
    after: Object.freeze(after),
    txId,
    seq,
    actor: Object.freeze({ kind: "unknown" }),
    fidelity: "value_only"
  });
}

function marker({ runId = "run", scenarioId = "scenario.one", nonce = "nonce", boundary, seq, txId }) {
  return event({
    entity: WATERMARK_ENTITY,
    op: "insert",
    seq,
    txId,
    after: {
      run_id: runId,
      scenario_id: scenarioId,
      surface: "web",
      seq: 1,
      nonce,
      boundary
    }
  });
}

test("ensureWatermarkTable provisions only the Attest schema and table without a clock default", async () => {
  const client = clientFor();

  await ensureWatermarkTable(client);
  await ensureWatermarkTable(client);

  assert.equal(client.queries.length, 4);
  assert.match(client.queries[0].text, /CREATE SCHEMA IF NOT EXISTS attest/u);
  assert.match(client.queries[1].text, /CREATE TABLE IF NOT EXISTS attest\.watermark/u);
  assert.match(client.queries[1].text, /PRIMARY KEY \(run_id, scenario_id, surface, seq, nonce, boundary\)/u);
  assert.doesNotMatch(client.queries[1].text, /\bnow\s*\(/iu);
  assert.doesNotMatch(client.queries[1].text, /\bclock_timestamp\s*\(/iu);
  assert.doesNotMatch(client.queries[1].text, /\bstatement_timestamp\s*\(/iu);
});

test("writeMarker inserts one marker row in its own committed transaction", async () => {
  const client = clientFor();

  const result = await writeMarker(client, {
    runId: "run",
    scenarioId: "scenario.one",
    surface: "web",
    seq: 2,
    nonce: "nonce",
    kind: "open"
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    client.queries.map((entry) => entry.text.trim().split(/\s+/u).slice(0, 3).join(" ")),
    ["BEGIN", "INSERT INTO attest.watermark", "COMMIT"]
  );
  assert.deepEqual(client.queries[1].values, ["run", "scenario.one", "web", 2, "nonce", "open"]);
});

test("writeMarker rolls back the marker transaction when the insert fails", async () => {
  const client = clientFor({ failInsert: true });

  await assert.rejects(
    () =>
      writeMarker(client, {
        runId: "run",
        scenarioId: "scenario.one",
        surface: "web",
        seq: 2,
        nonce: "nonce",
        kind: "close"
      }),
    /duplicate marker/u
  );

  assert.deepEqual(
    client.queries.map((entry) => entry.text.trim().split(/\s+/u)[0]),
    ["BEGIN", "INSERT", "ROLLBACK"]
  );
});

test("sliceWindow returns only application events strictly between this window's markers", () => {
  const before = event({ seq: 0, txId: "outside-before", after: { id: 0 } });
  const inside = event({ seq: 2, txId: "inside", after: { id: 1 } });
  const after = event({ seq: 6, txId: "outside-after", after: { id: 2 } });
  const neighbor = marker({
    runId: "run",
    scenarioId: "scenario.two",
    nonce: "other",
    boundary: "open",
    seq: 3,
    txId: "neighbor"
  });
  const result = sliceWindow(
    [
      before,
      marker({ boundary: "open", seq: 1, txId: "harness-open" }),
      inside,
      neighbor,
      marker({ boundary: "close", seq: 4, txId: "harness-close" }),
      after
    ],
    { runId: "run", scenarioId: "scenario.one", nonce: "nonce" }
  );

  assert.deepEqual(result.events, [inside]);
  assert.deepEqual(result.harnessTxIds, ["harness-open", "harness-close"]);
});

test("sliceWindow refuses a stream with a missing open marker", () => {
  assert.throws(
    () =>
      sliceWindow([event({ seq: 1 }), marker({ boundary: "close", seq: 2, txId: "harness" })], {
        runId: "run",
        scenarioId: "scenario.one",
        nonce: "nonce"
      }),
    (error) => {
      assert.equal(error.code, "E_DB_WINDOW_UNFENCED");
      assert.equal(error.details.absent, "open");
      return true;
    }
  );
});

test("sliceWindow refuses a stream with a missing close marker", () => {
  assert.throws(
    () =>
      sliceWindow([marker({ boundary: "open", seq: 1, txId: "harness" }), event({ seq: 2 })], {
        runId: "run",
        scenarioId: "scenario.one",
        nonce: "nonce"
      }),
    (error) => {
      assert.equal(error.code, "E_DB_WINDOW_UNFENCED");
      assert.equal(error.details.absent, "close");
      return true;
    }
  );
});

test("sliceWindow refuses a close marker that appears before its open marker", () => {
  assert.throws(
    () =>
      sliceWindow(
        [
          marker({ boundary: "close", seq: 1, txId: "harness-close" }),
          event({ seq: 2 }),
          marker({ boundary: "open", seq: 3, txId: "harness-open" })
        ],
        { runId: "run", scenarioId: "scenario.one", nonce: "nonce" }
      ),
    (error) => {
      assert.equal(error.code, "E_DB_WINDOW_UNFENCED");
      assert.equal(error.details.absent, "close");
      assert.equal(error.details.reason, "close_before_open");
      return true;
    }
  );
});
