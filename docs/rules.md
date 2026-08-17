# Delta Rules

## What A Ruleset Is

A delta ruleset is a versioned YAML file that tells Attest how to classify captured database changes that were not declared as expected mutations.
It is named from the config key `db.rulesFile`.
If `db.rulesFile` is `null`, Attest uses an empty ruleset with `version: 1` and no rules.

The ruleset version is `1`.
The root shape is:

```yaml
version: 1
rules: []
```

Attest hashes the canonical ruleset with SHA 256.
That hash appears in the run record as `hashes.ruleset`.
Each scenario delta also stores `rulesetHash`.
Loosening a rule to turn a red run green changes the hash, so the change shows up in a diff.

As of plan 03-15 the CLI loads `db.rulesFile` exactly once per run, before lowering, and passes
the resulting hash into the suite config so it reaches `hashes.ruleset` in the run record.
A ruleset that fails to load prints a positional diagnostic (file, line, column, code) and the
run exits with the usage error code, before any scenario executes.

Rules are strict objects.
Unknown fields make the ruleset fail to load.
Duplicate rule ids make the ruleset fail to load.
Rule ids must match `^[a-z][a-z0-9_]*$`.
Each rule has an optional `cap`, with default `50`.
Each rule may have an optional `note`.

The four rule kinds are:

- `volatile_columns`
- `derived`
- `external_writer`
- `ignore`

## Volatile Columns

Use `volatile_columns` when an update path is expected to change but the row still needs another explanation.
This rule strips matching paths from update comparison.
It does not make the row disappear.

```yaml
version: 1
rules:
  - id: session_updated_at
    kind: volatile_columns
    entity: sessions
    paths:
      - updated_at
    cap: 50
    note: updated_at is maintained by the application on session writes
```

Mandatory fields:

- `id`, because suppression accounting and dead rule health are tracked by stable rule id.
- `kind`, because rules are parsed by the `kind` discriminator.
- `entity`, because the rule must name the table it can touch.
- `paths`, because the rule must say which changed paths are volatile.

`paths` must be a non empty array.
Path segments may contain `*`.
The table name in `entity` may not use a wildcard.

## Derived

Use `derived` when one expected source mutation legitimately causes a bounded number of secondary rows.
Typical examples are audit rows, outbox rows, trigger rows, and cascade rows.

```yaml
version: 1
rules:
  - id: order_delete_audit
    kind: derived
    entity: audit_events
    caused_by:
      entity: orders
      op: delete
    mechanism: trigger
    per_source: 1
    cap: 50
    note: deleting one order writes one audit_events row
```

Mandatory fields:

- `id`, because the run record and suppression table report counts by rule id.
- `kind`, because the rule engine chooses the matcher from the rule kind.
- `entity`, because the rule must name the derived table it may explain.
- `caused_by`, because a derived change must name the source mutation that caused it.
- `caused_by.entity`, because the source mutation must name its source table.
- `caused_by.op`, because the source mutation must name `insert`, `update`, or `delete`.
- `mechanism`, because the operator must know why the derived write exists.
- `per_source`, because one source mutation must only explain a bounded number of derived rows.

A derived rule must name its source mutation and a cardinality, so one delete explaining 47 audit rows still fails.
The allowed operations in `caused_by.op` are `insert`, `update`, and `delete`.
`per_source` must be a positive integer.

## External Writer

Use `external_writer` when a background process writes to a table during the same fenced database window.
The rule must identify the writer.
It is not a table mute.

```yaml
version: 1
rules:
  - id: metrics_from_other_transaction
    kind: external_writer
    entity: metrics_events
    identity:
      by: transaction
      not_in: scenario_transactions
    cap: 50
    note: background metrics jobs use transactions outside the scenario
```

Mandatory fields:

- `id`, because every run prints per rule counts by id.
- `kind`, because the ruleset schema is a discriminated union on `kind`.
- `entity`, because external writer suppression is scoped to one table name.
- `identity`, because the rule must prove the write was not from the scenario.
- `identity.by`, because identity matching must declare the predicate type.

For transaction identity, the exact shape is:

```yaml
identity:
  by: transaction
  not_in: scenario_transactions
```

For application name identity, the exact shape is:

```yaml
identity:
  by: application_name
  not_equals: attest
```

The Postgres descriptor supports transaction identity through `txAttribution: true`.
Application name identity requires driver support through fields such as `applicationNameAttribution`, `identityPredicates`, or `attribution`.
If the driver does not support the requested identity predicate, compilation fails with `E_RULE_IDENTITY_UNSUPPORTED`.

## Ignore

Use `ignore` only as a temporary escape hatch.
It suppresses matching changes on one table until the expiry date.

```yaml
version: 1
rules:
  - id: temporary_legacy_sessions
    kind: ignore
    entity: legacy_sessions
    reason: legacy cleanup writes during sign in until the replacement job is removed
    expires: 2026-12-31
    cap: 10
    note: remove after the cleanup job is deleted
```

Mandatory fields:

- `id`, because an ignored change must be reviewable in suppression accounting.
- `kind`, because the matcher is selected by rule kind.
- `entity`, because the escape hatch must be scoped to one table.
- `reason`, because a reviewer needs the written reason for accepting the blind spot.
- `expires`, because permanent ignores are not allowed.

An ignore rule requires a written reason and an expiry date.
An expired ignore fails the run.
The schema rejects an already expired ignore with `E_RULESET_SCHEMA`.
The compiler also raises `E_RULE_EXPIRED` for expired ignore rules.

Wildcards are forbidden in ignore rules on table names.
The ignore entity check rejects `*`, `%`, and a trailing `_`.
A wildcard makes the ruleset fail to load with `E_RULESET_SCHEMA`.
The schema message is:
`DELTA-08 wildcard table names are banned for ignore rules`

## Mandatory Fields By Kind

All rules require `id` so they can be hashed, counted, reviewed, and tracked across runs.
All rules require `kind` so the ruleset can be parsed and dispatched to the correct matcher.
All rules require `entity` so the rule has a table boundary.

`volatile_columns` also requires `paths`.
Without `paths`, the rule would not say which changed values are volatile.

`derived` also requires `caused_by`, `mechanism`, and `per_source`.
Without `caused_by`, the rule is no longer causal.
Without `mechanism`, the operator cannot tell why the extra rows exist.
Without `per_source`, the rule could turn one source mutation into an unlimited number of suppressed rows.

`external_writer` also requires `identity`.
Without `identity`, the rule would be a table mute instead of an attribution rule.

`ignore` also requires `reason` and `expires`.
Without `reason`, the blind spot has no reviewable justification.
Without `expires`, the blind spot can become permanent.

## Caps And Rule Too Broad

The absolute default cap is `50`.
The constant is `CAP_DEFAULT = 50` in `src/delta/rules/caps.mjs`.
The ruleset schema also defaults each rule `cap` to `50`.

The suppressing rule kinds are:

- `derived`
- `external_writer`
- `ignore`

If a suppressing rule suppresses more rows than its `cap`, Attest reports `rule_too_broad`.
The assertion code maps this to `E_RULE_TOO_BROAD`.
The violation reason is `absolute_cap`.

Derived rules also enforce declared cardinality.
The budget is the source count times `per_source`.
Rows beyond that budget are over budget.
A rule suppressing beyond its declared cardinality fails the run as `rule_too_broad`.
The violation reason is `declared_cardinality`.

Not yet implemented: derived rule stats currently report `suppressed`, `overBudget`, and `cap`, but do not record `sourceCount` or `perSource` in the final rule table.
The over budget path still fails with `E_RULE_TOO_BROAD`.

## Dead Rules

Every rule is represented in rule stats, including rules that suppressed nothing.
The console prints the rule table under `Delta rule suppressions:`.
The table columns are `Rule`, `Kind`, `Entity`, `Suppressed`, `Over budget`, `Cap`, and `Health`.

Rule health is tracked across runs by the health store.
The default store path is `.attest/rule-health.json`.
The health store records each rule by id plus rule hash.
It records `consecutiveZeroRuns` and `lastFireCount`.

A rule that fires zero times is visible immediately because its `Suppressed` count is `0`.
After `3` consecutive zero fire runs, the rule is reported as dead.
The dead rule carries `proposedAction: delete_rule`.

If the rule changes, its rule hash changes.
That starts a new health history for that rule shape.

## Per Rule Suppression Counts

Per rule suppression counts print every run that has delta results.
Rules that suppressed nothing still appear.
The HTML view and run record carry the same accounting.

Each rule accounting row stores:

- `id`
- `kind`
- `entity`
- `suppressed`
- `overBudget`
- `cap`
- `dead`
- `expired`

The console rule table marks over budget rules as `rule_too_broad`.
It marks dead rules as `dead: delete_rule`.
It marks expired rules as `expired`.

## Operator Warning Signs

- an ignore list longer than ten entries
- any wildcard in an ignore
- a rule with no expires
- a run where the suppressed count exceeds the expected count
- anyone describing a failure as "that's just the audit table" more than once

## Phase 4 Gate

Phase 3 is not signed off until Phase 4 reports a kill rate against the seeded mutant corpus.
Passing tests written alongside the rule engine are not evidence that the rule engine still catches anything.
