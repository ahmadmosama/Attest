import assert from "node:assert/strict";
import test from "node:test";

import { hashRule, hashRuleset } from "../../../src/delta/rules/hash.mjs";
import { RULESET_VERSION, RulesetSchema } from "../../../src/delta/rules/schema.mjs";
import { ScenarioSchema } from "../../../src/ir/schema.mjs";
import { SUPPRESSION_KINDS, SuppressionSchema } from "../../../src/ir/suppression.mjs";

const BASE_RULES = Object.freeze([
  {
    id: "volatile_order_dates",
    kind: "volatile_columns",
    entity: "orders",
    paths: ["updated_at", "metadata.*"],
    note: "Timestamp values are maintained by the database."
  },
  {
    id: "order_delete_audit",
    kind: "derived",
    entity: "order_audit",
    caused_by: { entity: "orders", op: "delete" },
    mechanism: "trigger",
    per_source: 1
  },
  {
    id: "jobs_written_elsewhere",
    kind: "external_writer",
    entity: "jobs",
    identity: { by: "transaction", not_in: "scenario_transactions" }
  },
  {
    id: "temporary_legacy_import",
    kind: "ignore",
    entity: "legacy_import_log",
    reason: "Backfill writes are reconciled outside the scenario until the migration finishes.",
    expires: "2099-01-01"
  }
]);

function validRuleset(overrides = {}) {
  return {
    version: RULESET_VERSION,
    rules: BASE_RULES.map((rule) => ({ ...rule })),
    ...overrides
  };
}

function parseFailure(value) {
  const parsed = RulesetSchema.safeParse(value);
  assert.equal(parsed.success, false);
  return parsed.error.issues;
}

test("the shared suppression vocabulary has exactly four kinds", () => {
  assert.deepEqual(SUPPRESSION_KINDS, [
    "volatile_columns",
    "derived",
    "external_writer",
    "ignore"
  ]);

  const parsed = SuppressionSchema.safeParse({
    kind: "blacklist",
    entity: "orders"
  });

  assert.equal(parsed.success, false);
});

test("scenario suppressions import the shared four-kind schema", () => {
  const scenario = {
    id: "checkout.suppression_rules",
    requirement: ["DELTA-05"],
    suppressions: BASE_RULES.map((rule) => {
      const suppression = { ...rule };
      delete suppression.id;
      delete suppression.note;
      return suppression;
    }),
    steps: [{ open: "screen:catalog" }]
  };

  const parsed = ScenarioSchema.safeParse(scenario);

  assert.equal(parsed.success, true);
});

test("ignore requires a written reason and an expiry date", () => {
  const withoutReason = validRuleset({
    rules: [
      {
        id: "ignore_without_reason",
        kind: "ignore",
        entity: "legacy_import_log",
        expires: "2099-01-01"
      }
    ]
  });
  const withoutExpiry = validRuleset({
    rules: [
      {
        id: "ignore_without_expiry",
        kind: "ignore",
        entity: "legacy_import_log",
        reason: "Temporary migration cleanup."
      }
    ]
  });

  assert(parseFailure(withoutReason).some((issue) => issue.path.join(".") === "rules.0.reason"));
  assert(parseFailure(withoutExpiry).some((issue) => issue.path.join(".") === "rules.0.expires"));
});

test("expired ignore rules fail", () => {
  const issues = parseFailure(
    validRuleset({
      rules: [
        {
          id: "expired_ignore",
          kind: "ignore",
          entity: "legacy_import_log",
          reason: "Old migration window.",
          expires: "2000-01-01"
        }
      ]
    })
  );

  assert(issues.some((issue) => /expired/.test(issue.message)));
});

test("wildcards are rejected in ignore entities and accepted in volatile paths", () => {
  for (const entity of ["legacy*", "legacy%", "legacy_"]) {
    const wildcardIgnoreIssues = parseFailure(
      validRuleset({
        rules: [
          {
            id: "wildcard_ignore",
            kind: "ignore",
            entity,
            reason: "Temporary migration cleanup.",
            expires: "2099-01-01"
          }
        ]
      })
    );

    assert(wildcardIgnoreIssues.some((issue) => /DELTA-08/.test(issue.message)), entity);
  }

  const volatileWithWildcard = RulesetSchema.safeParse(
    validRuleset({
      rules: [
        {
          id: "wildcard_path",
          kind: "volatile_columns",
          entity: "orders",
          paths: ["metadata.*"]
        }
      ]
    })
  );

  assert.equal(volatileWithWildcard.success, true);
});

test("derived rules require a positive cardinality", () => {
  const missingCardinality = parseFailure(
    validRuleset({
      rules: [
        {
          id: "missing_cardinality",
          kind: "derived",
          entity: "order_audit",
          caused_by: { entity: "orders", op: "delete" },
          mechanism: "trigger"
        }
      ]
    })
  );
  const zeroCardinality = parseFailure(
    validRuleset({
      rules: [
        {
          id: "zero_cardinality",
          kind: "derived",
          entity: "order_audit",
          caused_by: { entity: "orders", op: "delete" },
          mechanism: "trigger",
          per_source: 0
        }
      ]
    })
  );

  assert(missingCardinality.some((issue) => issue.path.join(".") === "rules.0.per_source"));
  assert(zeroCardinality.some((issue) => issue.path.join(".") === "rules.0.per_source"));
});

test("external_writer requires a typed identity predicate", () => {
  const issues = parseFailure(
    validRuleset({
      rules: [
        {
          id: "background_jobs",
          kind: "external_writer",
          entity: "jobs",
          identity: {}
        }
      ]
    })
  );

  assert(issues.some((issue) => issue.path.join(".") === "rules.0.identity.by"));
});

test("ignore expiry must be an ISO date", () => {
  const issues = parseFailure(
    validRuleset({
      rules: [
        {
          id: "bad_date",
          kind: "ignore",
          entity: "legacy_import_log",
          reason: "Temporary migration cleanup.",
          expires: "not-a-date"
        }
      ]
    })
  );

  assert(issues.some((issue) => issue.path.join(".") === "rules.0.expires"));
});

test("rulesets require version 1", () => {
  const issues = parseFailure(validRuleset({ version: 2 }));

  assert(issues.some((issue) => /version must be 1/.test(issue.message)));
});

test("rules require ids and default caps", () => {
  const parsed = RulesetSchema.safeParse(
    validRuleset({
      rules: [
        {
          id: "volatile_order_dates",
          kind: "volatile_columns",
          entity: "orders",
          paths: ["updated_at"]
        }
      ]
    })
  );
  const badIdIssues = parseFailure(
    validRuleset({
      rules: [
        {
          id: "Bad-Id",
          kind: "volatile_columns",
          entity: "orders",
          paths: ["updated_at"]
        }
      ]
    })
  );

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.rules[0].cap, 50);
  assert(badIdIssues.some((issue) => issue.path.join(".") === "rules.0.id"));
});

test("duplicate rule ids fail at parse", () => {
  const issues = parseFailure(
    validRuleset({
      rules: [
        {
          id: "same_rule",
          kind: "volatile_columns",
          entity: "orders",
          paths: ["updated_at"]
        },
        {
          id: "same_rule",
          kind: "external_writer",
          entity: "jobs",
          identity: { by: "application_name", not_equals: "worker" }
        }
      ]
    })
  );

  assert.equal(issues.filter((issue) => /duplicate rule id/.test(issue.message)).length, 2);
});

test("rules are strict but may include a note", () => {
  const withNote = RulesetSchema.safeParse(
    validRuleset({
      rules: [
        {
          id: "noted_rule",
          kind: "volatile_columns",
          entity: "orders",
          paths: ["updated_at"],
          note: "Database updates this column on every write."
        }
      ]
    })
  );
  const unknownKeyIssues = parseFailure(
    validRuleset({
      rules: [
        {
          id: "extra_key",
          kind: "volatile_columns",
          entity: "orders",
          paths: ["updated_at"],
          unknown: true
        }
      ]
    })
  );

  assert.equal(withNote.success, true);
  assert(unknownKeyIssues.some((issue) => issue.path.join(".") === "rules.0"));
});

test("ruleset hashes are stable, order independent, and sensitive to field edits", () => {
  const first = RulesetSchema.parse(validRuleset());
  const reordered = RulesetSchema.parse({
    version: RULESET_VERSION,
    rules: validRuleset().rules.toReversed()
  });
  const edited = RulesetSchema.parse({
    version: RULESET_VERSION,
    rules: validRuleset().rules.map((rule) =>
      rule.id === "order_delete_audit" ? { ...rule, per_source: 2 } : rule
    )
  });
  const hash = hashRuleset(first);

  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, hashRuleset(reordered));
  assert.notEqual(hash, hashRuleset(edited));
  assert.match(hashRule(first.rules[0]), /^[a-f0-9]{64}$/);
  assert.notEqual(hashRule(first.rules[0]), hashRule({ ...first.rules[0], cap: 51 }));
});
