import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

import { hashRuleset } from "../../../src/delta/rules/hash.mjs";
import { RULESET_VERSION } from "../../../src/delta/rules/schema.mjs";
import { loadRuleset, parseRuleset } from "../../../src/delta/rules/load.mjs";
import { formatDiagnostic } from "../../../src/ir/diagnostics.mjs";

const EXAMPLE_RULESET = "examples/shopdemo/rules/shopdemo.rules.yaml";

function validRulesetText() {
  return `version: 1
rules:
  - id: volatile_order_dates
    kind: volatile_columns
    entity: orders
    paths: [updated_at, metadata.*]
  - id: order_delete_audit
    kind: derived
    entity: order_audit
    caused_by:
      entity: orders
      op: delete
    mechanism: trigger
    per_source: 1
  - id: background_jobs
    kind: external_writer
    entity: jobs
    identity:
      by: application_name
      not_equals: queue_worker
  - id: temporary_legacy_import
    kind: ignore
    entity: legacy_import_log
    reason: Backfill writes are reconciled outside this scenario.
    expires: 2099-01-01
`;
}

test("parseRuleset loads a valid ruleset with hash and id index", () => {
  const result = parseRuleset(validRulesetText(), { file: "rules.yaml" });

  assert.equal(result.diagnostics.ok, true);
  assert.equal(result.value.path, "rules.yaml");
  assert.match(result.value.hash, /^[a-f0-9]{64}$/);
  assert.equal(result.value.byId.order_delete_audit.kind, "derived");
  assert(Object.isFrozen(result.value));
  assert(Object.isFrozen(result.value.ruleset));
  assert(Object.isFrozen(result.value.ruleset.rules));
  assert(Object.isFrozen(result.value.byId));
});

test("schema violations produce positioned diagnostics", () => {
  const text = `version: 1
rules:
  - id: bad_ignore
    kind: ignore
    entity: legacy_import_log
    reason: Missing expiry.
`;
  const result = parseRuleset(text, { file: "rules.yaml" });

  assert.equal(result.value, null);
  assert.equal(result.diagnostics.ok, false);
  assert.equal(result.diagnostics.errors[0].file, "rules.yaml");
  assert.equal(result.diagnostics.errors[0].line, 3);
  assert(result.diagnostics.errors[0].col > 0);
  assert.equal(result.diagnostics.errors[0].code, "E_RULESET_SCHEMA");
  assert.deepEqual(result.diagnostics.errors[0].path, ["rules", 0, "expires"]);
  assert.match(formatDiagnostic(result.diagnostics.errors[0]), /^rules\.yaml:3:/);
});

test("missing rules file can be represented by null and still hashes", async () => {
  const loaded = await loadRuleset({ file: null });
  const emptyRuleset = { version: RULESET_VERSION, rules: [] };

  assert.equal(loaded.path, null);
  assert.deepEqual(loaded.ruleset, emptyRuleset);
  assert.equal(loaded.hash, hashRuleset(emptyRuleset));
  assert.deepEqual(loaded.byId, {});
  assert(Object.isFrozen(loaded));
});

test("invalid YAML produces diagnostics instead of throwing", () => {
  const result = parseRuleset("version: 1\nrules:\n  - id: [", { file: "broken.rules.yaml" });

  assert.equal(result.value, null);
  assert.equal(result.diagnostics.ok, false);
  assert.equal(result.diagnostics.errors[0].code, "E_RULESET_YAML");
  assert.equal(result.diagnostics.errors[0].file, "broken.rules.yaml");
  assert(result.diagnostics.errors[0].line > 0);
  assert(result.diagnostics.errors[0].col > 0);
});

test("example shopdemo ruleset loads and contains one rule of each kind", async () => {
  const text = await readFile(EXAMPLE_RULESET, "utf8");
  const parsed = parseRuleset(text, { file: EXAMPLE_RULESET });
  const loaded = await loadRuleset({ file: EXAMPLE_RULESET });
  const kinds = loaded.ruleset.rules.map((rule) => rule.kind).toSorted();

  assert.equal(parsed.diagnostics.ok, true);
  assert.deepEqual(kinds, ["derived", "external_writer", "ignore", "volatile_columns"]);
});
