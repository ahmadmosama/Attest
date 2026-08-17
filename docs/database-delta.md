# Database Delta

## Pointing Attest at a database

Attest takes the live database target from the environment only.

Use `ATTEST_DB_URL` for the target that a run should inspect:

```powershell
$env:ATTEST_DB_URL = "postgres://postgres:<password>@127.0.0.1:5432/postgres"
```

Do not put a connection string in the config file.
The config schema declares `db.url` as forbidden with this message:
`db.url is not allowed. Set ATTEST_DB_URL in the environment.`
If `db.url` appears in the config file, config validation fails with `E_CONFIG_INVALID`.

The config file may contain the allowlist, rules file, timing knobs, redaction policy, and tenant prefix.
The allowlist entry shape is exactly:

```yaml
db:
  allowlist:
    - host: 127.0.0.1
      database: postgres
      nonProd: true
      note: local Supabase database
```

`host` and `database` must match the parsed target.
Wildcards in `host` or `database` do not match.
`nonProd` must be `true`.
`note` is mandatory so a reviewer can see why this target is allowed.

The resolver refuses targets before opening a database connection.
The target refusal codes are:

- `E_DB_TARGET_INVALID`, the URL is missing, empty, malformed, has no host, or has no database name.
- `E_DB_TARGET_UNSUPPORTED`, the target is not `postgres` or `postgresql`.
- `E_DB_POOLER_PORT`, the target uses port `6543`.
- `E_DB_TARGET_NOT_ALLOWLISTED`, the `host` and `database` pair is not in `db.allowlist`.
- `E_DB_TARGET_NOT_MARKED`, the allowlist entry exists but is not marked `nonProd: true`.

For Supabase, use the direct session endpoint.
Attest refuses the Supabase transaction pooler on port `6543` because logical replication, session settings, preflight checks, and slot handling require a direct session.
The default Postgres port is `5432` when the URL omits a port.

Two environment variables exist and they are not interchangeable.
`ATTEST_DB_URL` is the one the CLI resolves a target from, in `src/config/resolve.mjs`.
`ATTEST_PG_URL` is the test harness variable: it is what the Postgres integration and acceptance
tests skip on when it is absent, and the Postgres connection helper reads it as a password source
only when it matches the already resolved target.
Set both to the same value when running the suite against a live database.

The CLI is wired to this layer as of plan 03-15.
When `ATTEST_DB_URL` resolves to an allowlisted target, `src/cli/commands/run.mjs` probes
capabilities once for the whole run, loads the ruleset once, lowers scenarios against the real
driver descriptor rather than `NOT_IMPLEMENTED_DB_CAPS`, and passes a per scenario hook factory
into `runSuite`. With no database configured the CLI still lowers against
`NOT_IMPLEMENTED_DB_CAPS` and contacts nothing, so the web only path is unchanged.

## Local development target

The local Supabase Postgres container used for Phase 3 testing is
`attest_pg_local`. On this machine, container port `5432`
is mapped to host port `54322`.

Use an environment-only connection string when running live Postgres tests:

```powershell
$env:ATTEST_PG_URL = "postgres://postgres:<password>@127.0.0.1:54322/postgres"
```

Do not use the Supabase transaction pooler on port `6543`. Attest must connect
to the direct session endpoint so preflight can verify primary status, logical
WAL support, replication privilege, and replication slot capacity.

## What Capture Does

Postgres capture uses the `logical_slot` capture strategy and the `test_decoding` parser.
For each delta scenario in a run, Attest derives one slot name from `runId`, `scenarioId`, and `surface`.
Slot names start with `attest_`, contain only lowercase letters, digits, and underscores, and stay inside the Postgres 63 byte identifier limit.

The slot is created with:

```sql
SELECT pg_create_logical_replication_slot($1, 'test_decoding');
```

The slot is drained with:

```sql
SELECT lsn::text AS lsn, xid::text AS xid, data
FROM pg_logical_slot_get_changes($1, NULL, $2);
```

The decoded stream gives Attest ordered row changes, `xid` transaction ids, LSN values, table names, operation names, row keys, changed paths, and row images at the fidelity Postgres can provide.
`INSERT`, `UPDATE`, and `DELETE` become change events.
`BEGIN` and `COMMIT` are used for transaction grouping.

The driver drops the slot during teardown, and process signal handlers also try to drop registered open slots on `SIGINT`, `SIGTERM`, and `beforeExit`.
The driver preflight path also sweeps inactive orphan slots whose names start with `attest_`.
Active slots are skipped, because another process may still own them.

An unconsumed logical replication slot is a disk risk.
Postgres keeps WAL needed by a slot until the slot advances or is dropped.
If an Attest slot is left behind and never consumed, WAL can be retained indefinitely.
On a small Supabase project, that can become an availability problem.

Check for leftover Attest slots with:

```sql
SELECT
  slot_name,
  plugin,
  slot_type,
  active,
  restart_lsn,
  confirmed_flush_lsn
FROM pg_replication_slots
WHERE slot_name LIKE 'attest\_%' ESCAPE '\'
ORDER BY slot_name;
```

If a slot is confirmed stale and inactive, drop it with:

```sql
SELECT pg_drop_replication_slot('attest_example_slot_name');
```

## Preflight

The Postgres preflight check names are:

- `primary_target`
- `wal_level`
- `replication_privilege`
- `slot_capacity`
- `replica_identity`

`primary_target` runs `SELECT pg_is_in_recovery() AS in_recovery`.
If the database is a replica, Attest refuses with `E_DB_REPLICA_TARGET`.
Delta assertions must observe the primary, because a read replica can lag behind the application write.

`wal_level` runs `SHOW wal_level`.
If the value is not `logical`, the check degrades with the message that logical slot capture is unavailable.
The Postgres driver then cannot select `logical_slot` capture and reports `E_DB_CAPTURE_UNSUPPORTED`.

`replication_privilege` checks `rolreplication` and `rolsuper` for `current_user`.
If neither is true, the check degrades with the message that logical slot capture is unavailable.
The Postgres driver then cannot select `logical_slot` capture and reports `E_DB_CAPTURE_UNSUPPORTED`.

`slot_capacity` checks `current_setting('max_replication_slots')::int` and the current count in `pg_replication_slots`.
If no slot capacity remains, Attest refuses with `E_DB_SLOT_LIMIT`.

`replica_identity` inspects `pg_class.relreplident` for the tables in scope.
Tables without `REPLICA IDENTITY FULL` are not silently accepted as full fidelity.
They degrade to `beforeImages: key_only`.
A changed column assertion that needs before images can then fail with `E_DELTA_FIDELITY_INSUFFICIENT` and the remediation text:
`Set REPLICA IDENTITY FULL on the table before asserting changed columns.`

## How A Window Is Fenced

Attest fences database windows with marker rows, not wall clock timestamps.

The marker table is `attest.watermark`.
It is created if needed with columns for `run_id`, `scenario_id`, `surface`, `seq`, `nonce`, `boundary`, and `created_at`.
Opening a window writes a row whose `boundary` is `open`.
Closing the window writes a row whose `boundary` is `close`.

The decoded stream contains those marker rows inline with application writes.
The scenario delta is the ordered stream after the matching open marker and before the matching close marker.
Attest removes the watermark rows from the application delta after slicing the window.

Wall clock timestamps are not a safe fence.
The harness host and database server can have clock skew.
Postgres `now()` is the transaction start time, not the commit time.
Column defaults can be evaluated before commit.
A timestamp window can include rows from the wrong scenario or exclude rows that belong to this one.

If either marker is missing, Attest raises `E_DB_WINDOW_UNFENCED`.

## Convergence And Quiet Period

Convergence means the expected mutations are visible to the observer connection.
Attest polls each expected mutation in a fresh `READ COMMITTED` transaction.
It does not hold one long transaction across polling attempts.

The schema knob is `db.convergeTimeoutMs`.
Its default is `10000`.
The Postgres window helper also has an internal `convergeIntervalMs` default of `50`.

The quiet period means no further captured changes arrive for a bounded period after convergence.
Attest drains the logical slot during this period.
If events keep arriving, the quiet period extends until the quiet period succeeds or the cap is reached.

The schema knobs are:

- `db.quietPeriodMs`, default `750`.
- `db.quietPeriodCapMs`, default `5000`.

The Postgres window helper default cap is `quietPeriodMs * 4` when no cap is supplied directly to it.
With the helper defaults, that is `3000`.

Not yet implemented: `db.convergeTimeoutMs`, `db.quietPeriodMs`, and `db.quietPeriodCapMs` exist in the config schema, but the current lowerer emits `convergeTimeoutMs: 10000` and `quietPeriodMs: 750` directly on `db_window_close` operations.
It does not emit `quietPeriodCapMs`, and the Postgres driver only passes operation fields into `closePostgresWindow`.

A convergence timeout returns a convergence result with `ok: false`, `attempts`, `elapsedMs`, and `lastError`.
The operator usually sees the delta assertion fail as `E_DELTA_MISSING_MUTATION`, with the expected table, operation, expected count, observed count, and missing count in the run record.
The run record also carries `convergeMs`.

## Isolation

Delta scenarios use scenario scoped tenancy.
The default tenant prefix in the config schema is `attest`.
Tenant keys must start with `attest_` and contain only lowercase letters, digits, and underscores.

Attest derives a tenant key from the run id, scenario id, and surface.
The default tenant column is `tenant_key`.
The default registry table is `public.attest_tenants`.
The reserved email domain is `attest.invalid`.

Declared seed data is applied inside the scenario tenant.
Seed documents must declare `entities` or `tables`.
Each entity names a table, an optional `tenantColumn`, and a `rows` array.
Seeds declare rows, not executable SQL or scripts.
Keys named `sql`, `query`, `script`, `execute`, or `raw` are refused with `E_SEED_UNSAFE`.
Non deterministic markers such as `$now`, `$random`, `$uuid`, `{{ now }}`, `{{ random }}`, `{{ uuid }}`, `{{ date.now }}`, and `{{ crypto.randomuuid }}` are refused with `E_SEED_NON_DETERMINISTIC`.

The seed digest is a SHA 256 fingerprint of the declared seed after canonicalization, excluding the tenant column.
A changed digest means the declared starting data changed.
If the observed pre state does not match the declared seed digest, Attest raises `E_SEED_DIGEST_MISMATCH`.

Transaction rollback isolation is structurally invalid for this harness.
The app under test is a separate process with its own database connections.
It cannot see the harness connection's uncommitted data.
The harness also cannot roll back writes that the app committed on its own connection.
The right isolation boundary is scenario scoped tenancy plus teardown, not a harness transaction around the scenario.

## One Run Per Database

Attest supports one run at a time against a given database.

Do not run two Attest runs against one database concurrently.
Two concurrent runs against the same database can sweep each other's replication slots.
A logical replication slot being polled reads as inactive between polls, and the orphan sweep drops inactive `attest_` slots so a crashed run cannot retain WAL forever.

The dangerous consequence is that a run whose slot was swept captures nothing.
A window that captured nothing has no unexplained changes, so it can report pass.

Attest's own test suite serializes its Postgres tests with a session level advisory lock for this reason.

## The Four Buckets

Every captured change lands in exactly one bucket.
If classification does not account for every change exactly once, Attest raises `E_DELTA_CLASSIFICATION_INCOMPLETE`.

`expected` contains changes that match a declared expected mutation by entity, operation, `where`, changed columns, and count budget.

`explained` contains changes explained by a typed rule, such as a derived audit row.

`suppressed_external` contains changes attributed to an external writer rule.
The current Postgres descriptor supports transaction attribution with `txAttribution: true`, so transaction identity can separate scenario transactions from other transactions.

`unexplained` contains everything left.
By default `requireNoUnexplained` is true, and any unexplained change fails the run with `E_DELTA_UNEXPLAINED`.
Only an operation that explicitly sets `requireNoUnexplained` to `false` avoids that failure.

The console and HTML report show all four counts.
The console header uses the labels `expected`, `explained`, `suppressed external`, and `unexplained`.
The run record stores the key as `suppressed_external`.

## Reading A Failure

A delta failure gives the operator the scenario, surface, step, requirements, and artifact directory.
For unexplained rows, the formatter groups by table and operation, then prints row key and column information.
For missing expected mutations, it reports the table, operation, expected count, and observed count.
For rule cap failures, it reports the rule id, reason, count, and cap.
For expired ignores, it reports the rule id and expiry date.

Look in `run.json` first.
At the scenario level, `scenario.delta` contains the classified delta for the scenario.
At the step level, `steps[n].delta` contains the delta attached to the failing step when the failure occurred during a database window close.
`steps[n].error.code` names the primary failure code, such as `E_DELTA_MISSING_MUTATION`, `E_DELTA_UNEXPLAINED`, `E_RULE_TOO_BROAD`, `E_RULE_EXPIRED`, or `E_DELTA_FIDELITY_INSUFFICIENT`.

The HTML report is written as `report.html` in the run artifact directory.
The CLI prints it as `HTML report: <path>`.
The report shows the four bucket counts, unexplained groups, shortfalls, ruleset hash, cap violations, and rule health.

## Serial By Default

The default config concurrency is `1`.
Even when `concurrency` is higher, plans that demand `db.delta_assertion` are forced to run serially unless the driver descriptor and config prove parallel attribution.

The runtime reason is:
`delta scenarios require transaction attribution, inline watermark fencing, and per scenario tenancy for parallel attribution`

Parallel delta execution requires one of these config flags:

- `parallelDelta: true`
- `deltaConcurrency: true`
- `db.parallelDelta: true`

It also requires these capability fields:

- `txAttribution: true`
- `watermarkFencing: "inline"`
- one of `perScenarioTenancy: true`, `scenarioTenancy: true`, or `transactionalTeardown: true`

The Postgres descriptor currently reports `txAttribution: true`, `watermarkFencing: "inline"`, and `transactionalTeardown: true` when logical capture is available.
Without the explicit parallel flag, delta scenarios still run serially.

The run record reports forced serial scheduling under `telemetry.deltaScheduling`.

## Phase 4 Gate

Phase 3 is not signed off until Phase 4 reports a kill rate against the seeded mutant corpus.
Passing tests written alongside the rule engine are not evidence that the rule engine still catches anything.
