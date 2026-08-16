import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defineDbCapabilities, NOT_IMPLEMENTED_DB_CAPS } from "../../../src/capabilities/db-caps.mjs";
import {
  CAPTURE_STRATEGIES,
  selectCaptureStrategy
} from "../../../src/db/capture/strategy.mjs";
import {
  parseChangeLine,
  parseSlotRows,
  TEST_DECODING_LINE_KINDS
} from "../../../src/db/capture/test-decoding.mjs";
import { AttestError } from "../../../src/errors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "../../fixtures/db/test-decoding");

function fixtureRows(name) {
  return readFileSync(join(FIXTURE_DIR, name), "utf8").trim().split(/\r?\n/u);
}

function parseData(data, options = {}) {
  return parseChangeLine(
    {
      lsn: "0/1",
      xid: "7",
      data
    },
    options
  ).event;
}

function postgresCaps(overrides = {}) {
  return defineDbCapabilities({
    driver: "postgres",
    capture: "logical_slot",
    deltaAssertion: true,
    boundedPolling: true,
    beforeImages: "full",
    ordering: true,
    txAttribution: true,
    watermarkFencing: "inline",
    transactionalTeardown: true,
    ...overrides
  });
}

test("value tokenizer preserves adversarial quoted values and typed primitives", () => {
  const event = parseData(
    "table public.t: INSERT: id[integer]:1 name[text]:'ahmad' note[text]:'a: b, c' quote[text]:'it''s fine' deleted_at[timestamp with time zone]:null payload[jsonb]:'{\"a\": 1}' amount[numeric]:'19.99' flag[boolean]:t other_flag[boolean]:f score[double precision]:1.5 data[bytea]:'\\x0102'",
    {
      keyColumns: {
        "public.t": ["id"]
      }
    }
  );

  assert.equal(event.op, "insert");
  assert.deepEqual(event.key, { id: 1 });
  assert.deepEqual(event.after, {
    amount: "19.99",
    data: "\\x0102",
    deleted_at: null,
    flag: true,
    id: 1,
    name: "ahmad",
    note: "a: b, c",
    other_flag: false,
    payload: "{\"a\": 1}",
    quote: "it's fine",
    score: 1.5
  });
});

test("truncated tokens raise a named unparseable change error with the fragment", () => {
  assert.throws(
    () => parseData("table public.t: INSERT: name[text]:"),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_DB_UNPARSEABLE_CHANGE" &&
      error.details.fragment.includes("name[text]:")
  );
});

test("BEGIN and COMMIT lines classify as transaction boundaries", () => {
  const begin = parseChangeLine("0/1|11|BEGIN 11");
  const commit = parseChangeLine("0/2|11|COMMIT 11");

  assert.equal(begin.kind, TEST_DECODING_LINE_KINDS.begin);
  assert.equal(commit.kind, TEST_DECODING_LINE_KINDS.commit);
  assert.equal(begin.event, null);
  assert.equal(commit.event, null);
  assert.equal(begin.txId, "11");
  assert.equal(commit.txId, "11");
});

test("INSERT uses after values and falls back to the tuple as key without a key map", () => {
  const event = parseData("table public.t: INSERT: id[integer]:1 name[text]:'ahmad'");

  assert.equal(event.entity, "public.t");
  assert.equal(event.op, "insert");
  assert.deepEqual(event.key, { id: 1, name: "ahmad" });
  assert.deepEqual(event.after, { id: 1, name: "ahmad" });
  assert.equal(event.before, null);
  assert.equal(event.fidelity, "value_only");
});

test("DELETE with key columns produces a key only delete event", () => {
  const event = parseData("table public.t: DELETE: id[integer]:1 name[text]:'ahmad'", {
    keyColumns: {
      "public.t": ["id"]
    }
  });

  assert.equal(event.op, "delete");
  assert.deepEqual(event.key, { id: 1 });
  assert.deepEqual(event.before, { id: 1, name: "ahmad" });
  assert.equal(event.after, null);
  assert.equal(event.fidelity, "key_only");
});

test("DELETE with no tuple data records a warning and keeps an empty key", () => {
  const warnings = [];
  const parsed = parseChangeLine(
    {
      lsn: "0/3",
      xid: "12",
      data: "table public.t: DELETE: (no-tuple-data)"
    },
    { warnings }
  );

  assert.equal(parsed.event.op, "delete");
  assert.deepEqual(parsed.event.key, {});
  assert.deepEqual(parsed.event.before, {});
  assert.equal(parsed.event.fidelity, "key_only");
  assert.equal(parsed.warnings.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].entity, "public.t");
});

test("UPDATE without a before image emits after only with key only fidelity", () => {
  const event = parseData("table public.t: UPDATE: id[integer]:1 name[text]:'b'", {
    keyColumns: {
      "public.t": ["id"]
    }
  });

  assert.equal(event.op, "update");
  assert.deepEqual(event.key, { id: 1 });
  assert.equal(event.before, null);
  assert.deepEqual(event.after, { id: 1, name: "b" });
  assert.equal(event.fidelity, "key_only");
});

test("UPDATE with old-key and new-tuple emits both images with full fidelity", () => {
  const event = parseData(
    "table public.t: UPDATE: old-key: id[integer]:1 name[text]:'a' note[text]:'has new-tuple: marker' new-tuple: id[integer]:1 name[text]:'b' note[text]:'has new-tuple: marker'",
    {
      keyColumns: {
        "public.t": ["id"]
      }
    }
  );

  assert.equal(event.op, "update");
  assert.deepEqual(event.key, { id: 1 });
  assert.deepEqual(event.before, {
    id: 1,
    name: "a",
    note: "has new-tuple: marker"
  });
  assert.deepEqual(event.after, {
    id: 1,
    name: "b",
    note: "has new-tuple: marker"
  });
  assert.deepEqual(event.paths, [["name"]]);
  assert.equal(event.fidelity, "full");
});

test("parseSlotRows preserves xid grouping, event order, and lsn on each event actor", () => {
  const rows = [
    "0/10|30|BEGIN 30",
    "0/10|30|table public.t: INSERT: id[integer]:1",
    "0/20|30|table public.t: UPDATE: id[integer]:1 name[text]:'b'",
    "0/30|30|COMMIT 30"
  ];

  const result = parseSlotRows(rows, {
    keyColumns: {
      "public.t": ["id"]
    },
    actorFor(input) {
      return input.op === "insert" ? { kind: "harness" } : { kind: "unknown" };
    }
  });

  assert.equal(result.events.length, 2);
  assert.deepEqual(result.transactions, { 30: [0, 1] });
  assert.equal(result.events[0].txId, "30");
  assert.equal(result.events[0].seq, 0);
  assert.equal(result.events[1].seq, 1);
  assert.equal(result.events[0].actor.kind, "harness");
  assert.equal(result.events[0].actor.lsn, "0/10");
  assert.equal(result.events[1].actor.lsn, "0/20");
});

test("unknown line kinds raise rather than being ignored", () => {
  assert.throws(
    () => parseChangeLine("0/1|7|message prefix: not a table change"),
    (error) => error instanceof AttestError && error.code === "E_DB_UNPARSEABLE_CHANGE"
  );
});

test("real insert and delete fixture parses with transaction grouping and no warnings", () => {
  const result = parseSlotRows(fixtureRows("insert-delete.txt"), {
    keyColumns: {
      "public.attest_td_0307_posts": ["id"],
      "public.attest_td_0307_users": ["id"]
    }
  });

  assert.equal(result.events.length, 4);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.events.map((event) => event.op), ["insert", "insert", "delete", "delete"]);
  assert.deepEqual(Object.values(result.transactions), [[0, 1, 2, 3]]);
});

test("real replica identity full fixture parses before and after images", () => {
  const result = parseSlotRows(fixtureRows("update-full.txt"), {
    keyColumns: {
      "public.attest_td_0307_update_full": ["id"]
    }
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.events[0].fidelity, "full");
  assert.equal(result.events[0].before.note, "it's fine");
  assert.equal(result.events[0].after.note, "a: b, c");
});

test("real default replica identity fixture parses after only and keeps numeric string", () => {
  const result = parseSlotRows(fixtureRows("update-default.txt"), {
    keyColumns: {
      "public.attest_td_0307_update_default": ["id"]
    }
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.events[0].fidelity, "key_only");
  assert.equal(result.events[0].before, null);
  assert.equal(result.events[0].after.amount, "19.99");
  assert.equal(result.events[0].after.payload, "{\"a\": 1}");
});

test("real no tuple data fixture parses with the deliberate degraded warning", () => {
  const result = parseSlotRows(fixtureRows("delete-no-tuple-data.txt"), {
    keyColumns: {
      "public.attest_td_0307_delete_none": ["id"]
    }
  });

  assert.equal(result.events.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].entity, "public.attest_td_0307_delete_none");
  assert.deepEqual(result.events[0].key, {});
});

test("capture strategy selector returns logical slot and rejects unsupported captures", () => {
  const strategy = selectCaptureStrategy(postgresCaps());

  assert.equal(strategy, CAPTURE_STRATEGIES.logical_slot);
  assert.equal(CAPTURE_STRATEGIES.logical_slot.implemented, true);
  assert.equal(CAPTURE_STRATEGIES.binlog.implemented, false);
  assert.equal(CAPTURE_STRATEGIES.change_stream.implemented, false);
  assert.equal(CAPTURE_STRATEGIES.snapshot.implemented, false);

  assert.throws(
    () => selectCaptureStrategy(NOT_IMPLEMENTED_DB_CAPS),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_DB_CAPTURE_UNSUPPORTED" &&
      error.details.driver === "none"
  );
  assert.throws(
    () => selectCaptureStrategy(postgresCaps({ capture: "snapshot" })),
    (error) =>
      error instanceof AttestError &&
      error.code === "E_DB_CAPTURE_UNSUPPORTED" &&
      error.details.reason === "strategy_not_implemented"
  );
});
