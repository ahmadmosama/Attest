import assert from "node:assert/strict";
import test from "node:test";

import { defineDbCapabilities } from "../../src/capabilities/db-caps.mjs";
import { createChangeEvent } from "../../src/db/change-event.mjs";
import { createDbHooks } from "../../src/db/hooks.mjs";
import { hashRuleset } from "../../src/delta/rules/hash.mjs";
import { AttestError, InfraError } from "../../src/errors.mjs";

function capabilities(overrides = {}) {
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

function event(overrides = {}) {
  return createChangeEvent({
    entity: "public.orders",
    key: { id: 1 },
    op: "insert",
    paths: [["id"]],
    before: null,
    after: { id: 1, status: "paid" },
    txId: "tx_app",
    seq: 1,
    actor: { kind: "app_session", applicationName: "shopdemo" },
    fidelity: "full",
    ...overrides
  });
}

function fakeClient(calls) {
  return {
    async query(sql, values = []) {
      calls.push(`sql:${String(sql).trim().split(/\s+/u).slice(0, 2).join(" ")}`);
      return { rows: [], values };
    }
  };
}

function fakeDriver({ calls, client = fakeClient(calls), caps = capabilities(), closeResult, preflightError } = {}) {
  return {
    client,
    describeCapabilities: () => caps,
    async preflight() {
      calls.push("driver:preflight");
      if (preflightError !== undefined) {
        throw preflightError;
      }
      return { ok: true };
    },
    async openWindow() {
      calls.push("driver:open");
      return { seq: 1, nonce: "nonce" };
    },
    async closeWindow() {
      calls.push("driver:close");
      return closeResult ?? {
        ok: true,
        events: [event()],
        converge: { ok: true, elapsedMs: 7 },
        quiet: { quiet: true, elapsedMs: 3, events: 0, extensions: 0 }
      };
    },
    async drain() {
      return [];
    },
    async poll() {
      return { ok: true };
    },
    async teardown() {
      calls.push("driver:teardown");
      return { ok: true };
    }
  };
}

function ctx() {
  return {
    runId: "20260815T044612Z-9f3a1c07",
    scenarioId: "checkout.guest_purchase",
    surface: "web",
    tenantPrefix: "attest",
    now: () => new Date("2026-08-16T00:00:00Z")
  };
}

test("db hooks provision, open, classify, assert, and return a redacted delta", async () => {
  const calls = [];
  const hooks = createDbHooks({
    driver: fakeDriver({ calls }),
    ruleset: null,
    runId: "20260815T044612Z-9f3a1c07",
    config: { ruleHealthPath: null }
  });

  await hooks.onWindowOpen({ i: 0, kind: "db_window_open", seq: 1 }, { ctx: ctx() });
  const result = await hooks.onWindowClose(
    {
      i: 1,
      kind: "db_window_close",
      seq: 1,
      expect: [{ entity: "public.orders", op: "insert", count: 1 }],
      requireNoUnexplained: true
    },
    { ctx: ctx() }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.delta.counts, {
    expected: 1,
    explained: 0,
    suppressed_external: 0,
    unexplained: 0
  });
  assert.equal(result.delta.capturedEventCount, 1);
  assert.equal(result.delta.rulesetHash, hashRuleset({ version: 1, rules: [] }));
  assert.equal(result.delta.convergeMs[0], 7);
  assert.deepEqual(calls.filter((call) => call.startsWith("driver:")), [
    "driver:preflight",
    "driver:open",
    "driver:close"
  ]);
});

test("delta violations throw AttestError with the step delta attached", async () => {
  const calls = [];
  const hooks = createDbHooks({
    driver: fakeDriver({
      calls,
      closeResult: {
        ok: true,
        events: [event({ entity: "public.customers", key: { id: 2 } })],
        converge: { ok: true, elapsedMs: 4 },
        quiet: { quiet: true, elapsedMs: 1, events: 0, extensions: 0 }
      }
    }),
    config: { ruleHealthPath: null }
  });

  await hooks.onWindowOpen({ i: 0, kind: "db_window_open", seq: 1 }, { ctx: ctx() });

  await assert.rejects(
    () => hooks.onWindowClose({ i: 1, kind: "db_window_close", seq: 1, expect: [] }, { ctx: ctx() }),
    (error) => {
      assert(error instanceof AttestError);
      assert.equal(error.code, "E_DELTA_UNEXPLAINED");
      assert.equal(error.details.delta.counts.unexplained, 1);
      assert.equal(error.details.delta.unexplained[0].entity, "public.customers");
      return true;
    }
  );
});

test("infrastructure failures stay InfraError and teardown remains idempotent", async () => {
  const calls = [];
  const unreachable = new InfraError("E_DB_UNREACHABLE", "database unreachable", {
    reason: "connection_refused"
  });
  const hooks = createDbHooks({
    driver: fakeDriver({ calls, preflightError: unreachable }),
    config: { ruleHealthPath: null }
  });

  await assert.rejects(
    () => hooks.onWindowOpen({ i: 0, kind: "db_window_open", seq: 1 }, { ctx: ctx() }),
    (error) => error === unreachable
  );

  await hooks.teardown();
  await hooks.teardown();

  assert.deepEqual(calls, ["driver:preflight", "driver:teardown", "driver:teardown"]);
});

test("driver without delta capability is rejected at hook construction", () => {
  const calls = [];

  assert.throws(
    () =>
      createDbHooks({
        driver: fakeDriver({ calls, caps: capabilities({ deltaAssertion: false }) }),
        config: { ruleHealthPath: null }
      }),
    (error) => error instanceof AttestError && error.code === "E_DB_DELTA_UNSUPPORTED"
  );
});

test("hooks honor an already aborted signal", async () => {
  const calls = [];
  const hooks = createDbHooks({
    driver: fakeDriver({ calls }),
    config: { ruleHealthPath: null }
  });
  const controller = new AbortController();
  controller.abort(new Error("stop"));

  await assert.rejects(
    () => hooks.onWindowOpen({ i: 0, kind: "db_window_open", seq: 1 }, { ctx: ctx(), signal: controller.signal }),
    (error) => error instanceof InfraError && error.code === "E_DB_WINDOW_OPEN_ABORTED"
  );
  assert.deepEqual(calls, []);
});
