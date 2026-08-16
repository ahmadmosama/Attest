import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  DEAD_RULE_RUNS,
  assessRuleHealth,
  createRuleHealthStore
} from "../../../src/delta/rules/health.mjs";

const TMP_ROOT = join(process.cwd(), "test", "delta", "rules", ".tmp-health");

function ruleset(rules) {
  return { version: 1, rules };
}

function derivedRule(overrides = {}) {
  return {
    id: "derived_audit",
    kind: "derived",
    entity: "audit_log",
    caused_by: { entity: "orders", op: "delete" },
    mechanism: "trigger",
    per_source: 1,
    cap: 50,
    ...overrides
  };
}

function ignoreRule(overrides = {}) {
  return {
    id: "temporary_ignore",
    kind: "ignore",
    entity: "audit_log",
    reason: "Temporary migration cleanup.",
    expires: "2026-08-20",
    cap: 50,
    ...overrides
  };
}

function stat(overrides = {}) {
  return {
    id: "derived_audit",
    kind: "derived",
    entity: "audit_log",
    suppressed: 0,
    overBudget: 0,
    cap: 50,
    ...overrides
  };
}

function storeFor(name) {
  return createRuleHealthStore({ path: join(TMP_ROOT, name, "rule-health.json") });
}

test.before(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

test.after(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

test("a zero fire rule increments its consecutive zero run counter", async () => {
  const store = storeFor("increments");
  const result = await assessRuleHealth({
    ruleStats: [stat()],
    ruleset: ruleset([derivedRule()]),
    store,
    now: () => new Date("2026-08-16T00:00:00Z")
  });

  const entry = Object.values(result.state.rules)[0];
  assert.equal(entry.consecutiveZeroRuns, 1);
  assert.deepEqual(result.dead, []);
});

test("dead rules are reported with proposed deletion after consecutive zero runs", async () => {
  const store = storeFor("dead");

  for (let index = 0; index < DEAD_RULE_RUNS; index += 1) {
    await assessRuleHealth({
      ruleStats: [stat()],
      ruleset: ruleset([derivedRule()]),
      store,
      now: () => new Date("2026-08-16T00:00:00Z")
    });
  }

  const result = await assessRuleHealth({
    ruleStats: [stat()],
    ruleset: ruleset([derivedRule()]),
    store,
    now: () => new Date("2026-08-16T00:00:00Z")
  });

  assert.equal(result.dead.length, 1);
  assert.equal(result.dead[0].ruleId, "derived_audit");
  assert.equal(result.dead[0].proposedAction, "delete_rule");
  assert.equal(result.failed, false);
});

test("a firing rule resets its counter to zero", async () => {
  const store = storeFor("reset");

  await assessRuleHealth({
    ruleStats: [stat()],
    ruleset: ruleset([derivedRule()]),
    store,
    now: () => new Date("2026-08-16T00:00:00Z")
  });
  const result = await assessRuleHealth({
    ruleStats: [stat({ suppressed: 1 })],
    ruleset: ruleset([derivedRule()]),
    store,
    now: () => new Date("2026-08-16T00:00:00Z")
  });

  const entry = Object.values(result.state.rules)[0];
  assert.equal(entry.consecutiveZeroRuns, 0);
});

test("editing a rule changes its hash and starts a fresh counter", async () => {
  const store = storeFor("edited");

  await assessRuleHealth({
    ruleStats: [stat()],
    ruleset: ruleset([derivedRule({ per_source: 1 })]),
    store,
    now: () => new Date("2026-08-16T00:00:00Z")
  });
  const result = await assessRuleHealth({
    ruleStats: [stat()],
    ruleset: ruleset([derivedRule({ per_source: 2 })]),
    store,
    now: () => new Date("2026-08-16T00:00:00Z")
  });

  const entries = Object.values(result.state.rules);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].consecutiveZeroRuns, 1);
});

test("expired and soon expiring ignore rules are reported with dates", async () => {
  const store = storeFor("expiry");
  const result = await assessRuleHealth({
    ruleStats: [
      stat({ id: "expired_ignore", kind: "ignore" }),
      stat({ id: "soon_ignore", kind: "ignore" })
    ],
    ruleset: ruleset([
      ignoreRule({ id: "expired_ignore", expires: "2026-08-15" }),
      ignoreRule({ id: "soon_ignore", expires: "2026-08-20" })
    ]),
    store,
    now: () => new Date("2026-08-16T00:00:00Z")
  });

  assert.deepEqual(result.expired, [
    { ruleId: "expired_ignore", id: "expired_ignore", expires: "2026-08-15" }
  ]);
  assert.equal(result.expiringSoon[0].ruleId, "soon_ignore");
  assert.equal(result.expiringSoon[0].expires, "2026-08-20");
  assert.equal(result.failed, true);
});

test("store defaults to .attest rule health path", () => {
  const store = createRuleHealthStore();

  assert.equal(store.path, ".attest/rule-health.json");
});

test("a corrupt store starts empty and the next write is valid json", async () => {
  const store = storeFor("corrupt");

  await mkdir(dirname(store.path), { recursive: true });
  await writeFile(store.path, "{not json", "utf8");

  const result = await assessRuleHealth({
    ruleStats: [stat()],
    ruleset: ruleset([derivedRule()]),
    store,
    now: () => new Date("2026-08-16T00:00:00Z")
  });
  const written = JSON.parse(await readFile(store.path, "utf8"));

  assert.equal(Object.values(result.state.rules)[0].consecutiveZeroRuns, 1);
  assert.equal(Object.values(written.rules)[0].consecutiveZeroRuns, 1);
});
