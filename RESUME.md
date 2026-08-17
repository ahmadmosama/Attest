# Attest: resume here

Updated 2026-08-17. Working tree is clean, everything below is committed.

## Where it stands

| Thing | State |
|---|---|
| Phases done | 4 of 7 complete, Phase 5 in progress |
| Phase 3 | Complete and SIGNED OFF, with a 90.91 percent kill rate |
| Phase 4 | Complete, 6 of 6 plans |
| Phase 5 | DROID-01 and DROID-03 done. DROID-02 locate done. Remaining: adapter, evidence, fixture APK |
| Tests | 721 passing, 0 failing, 0 skipped |
| Verified against | real PostgreSQL 17.6 and real Chrome, not mocks |
| Last commit | `ec4cc73 feat(05-03)` |

## Run the gate

```bash
cd "C:/Users/ahmad/Desktop/Claude/Attest"
export ATTEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres"
export ATTEST_DB_URL="$ATTEST_PG_URL"
npm run check
```

Without `ATTEST_PG_URL` the Postgres tests skip cleanly and the suite still
passes, so the gate stays green with no database. With it, they run for real.

Requires Docker running, container `attest_pg_local`
(PostgreSQL 17.6, `wal_level=logical`, published on host port 54322). Only that
one container is needed. The other 8 in the local stack can be stopped to free
roughly 890 MB. `a-pipeline-critical-service` must stay up, it is daily pipeline critical.

## Run the self verification

```bash
node src/cli/main.mjs selfcheck
```

Current output, reproduced through the real CLI:

```
Mutants: killed 10, survived 1, errored 0, total 11
Kill rate: 90.91% (0.9090909090909091)
Baseline: 90.91% (0.9090909090909091)
```

The single survivor, `survivor_create_audit_detail`, is a declared known blind
spot recorded in the corpus with its reason. A corpus that scores 100 percent by
construction measures nothing, so the honest number is the useful one.

`--update-baseline` is the only way the recorded rate moves. Raising the baseline
above the real rate makes `selfcheck` exit with the scenario failure code.

## What is left

| Phase | Scope | State |
|---|---|---|
| 5 | Android surface, plus the milestone demo | In progress, see below |
| 6 | SQLite, MySQL, Mongo, BigQuery drivers, plus scenario generation | Not planned |
| 7 | iOS on macOS CI, AtoZ pipeline stage, GSD hook | Not planned |

### Phase 5, what is done and what is next

Done and committed:

- `src/surfaces/android/commands.mjs`, pure adb argv construction, 12 builders, snapshot pinned.
- `src/surfaces/android/exec.mjs`, the only place that spawns adb, `shell: false`.
- `src/surfaces/android/emulator.mjs`, AVD start, real boot gating, infra classification, teardown.
- `src/surfaces/android/hierarchy.mjs`, uiautomator dump parsing, locate, ambiguity refusal.

DROID-01 and DROID-03 are complete. DROID-02's locate half is complete.

Next, in order:

1. `src/surfaces/android/adapter.mjs`, the surface port implementation, wiring locate plus
   `input tap` and `input text`, and registering the adapter in `src/surfaces/registry.mjs`.
2. Wire the Android adapter into `test/conformance/surface-port.mjs`, which Phase 4 built for
   exactly this. It should be one call.
3. Evidence capture for DROID-04: screenshot per checkpoint, `screenrecord` on failure, and the
   hierarchy dump at the failing step.
4. The fixture APK. Decision taken 2026-08-17: build a minimal Android app under
   `fixtures/self-verify/android` that talks to the existing fixture HTTP server on `10.0.2.2`,
   so the same Postgres delta assertions run on mobile. Gradle 8.14 is already cached in
   `~/.gradle/wrapper/dists`, and the JDK is the Android Studio JBR at
   `C:\Program Files\Android\Android Studio\jbr`. `java` is NOT on PATH, set `JAVA_HOME`.
5. Phase 5 acceptance against the live emulator, plus the milestone demo.

Phase 4 already landed two things Phases 5 and 7 inherit, so they should be
cheaper than they look:

- `test/conformance/surface-port.mjs` is a parameterised conformance suite that
  the fake and web adapters both pass. Wiring the Android adapter into it is one
  call. A clause may be skipped for a missing capability with a stated reason,
  never deleted.
- `src/surfaces/ios/commands.mjs` plus committed transcript snapshots make iOS
  command construction assertable on Windows, so Phase 7 starts from a tested
  command layer rather than from nothing.

## How the work has been running

Claude plans and verifies. Codex implements, one plan per call:

```bash
cd "C:/Users/ahmad/Desktop/Claude/Attest" && node "C:/Users/ahmad/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" task --write --cwd "C:/Users/ahmad/Desktop/Claude/Attest" --effort high "<self contained spec>"
```

**Codex hit its ChatGPT usage limit on 2026-08-17 and resets 2026-08-22.** Until
then, implement directly in Claude. The fallback is expected and is written into
the routing rule, it is not a failure state.

Every Codex prompt carries the filesystem boundary preamble, an explicit
allowlist of the files that plan owns, and the hard project constraints. Plans
within a wave have zero `files_modified` overlap so they run concurrently. Only
one plan per wave may touch `package.json`.

A reusable preamble is at
`AppData/Local/Temp/claude/.../scratchpad/preamble.txt`, but it is scratch and
will not survive. Rebuild it from the constraints listed below if it is gone.

After each wave: run the gate, verify the load bearing claims by an independent
probe rather than trusting the test output, check for leaked replication slots,
commit, move on.

## Things that will bite you if forgotten

1. **Test discovery is one glob on purpose.** `node --test "test/**/*.test.mjs"`
   discovers all files. A split light/heavy glob was tried and found only 34 of
   78, silently hiding 44 from the gate. Do not split it, do not add
   `test/index.mjs`, do not add `test/package.json`.
2. **Never let a test skip itself to dodge a failure.** During wave 7 a test file
   was made to skip whenever `npm_lifecycle_event === "test"`, which produced a
   green 606 test gate while 13 acceptance tests silently never ran. Legitimate
   skips are: no database reachable, or a capability the adapter does not
   declare, and they must state a reason.
3. **One Attest run at a time against a database.** A logical slot polled with
   `pg_logical_slot_get_changes` reads as inactive between polls, so a concurrent
   run's orphan sweep drops it. The dangerous direction is not a flaky test: a
   run whose slot was swept captures nothing, and a window that captured nothing
   has no unexplained changes, so it can report pass. The suite serializes its
   Postgres tests with `withPostgresSlotLock` in `test/helpers/postgres.mjs`.
   Documented in `docs/database-delta.md`.
4. **Concurrency is capped at 2 with a 120s per test timeout.** The heavy tests
   spawn child processes and launch Chrome.
5. **Replication slots are a disk risk.** Always verify after a DB run:
   ```bash
   docker exec attest_pg_local psql -U postgres -tAc "SELECT coalesce(string_agg(slot_name,', '),'NONE') FROM pg_replication_slots;"
   ```
   Expect `NONE`. Also check no leftover schemas:
   ```bash
   docker exec attest_pg_local psql -U postgres -tAc "SELECT coalesce(string_agg(schema_name,', '),'NONE') FROM information_schema.schemata WHERE schema_name LIKE 'attest_phase0%';"
   ```
   `attest.watermark` with 0 rows is expected and correct, it is the durable
   marker table, not debris.
6. **Machine memory is the real constraint.** Committed memory sits around 89
   percent of 31.4 GB on this box. Sweep zombie shells before a long run:
   `Get-Process cmd,conhost | Where-Object { $_.CPU -lt 0.5 -and $_.StartTime -lt (Get-Date).AddMinutes(-60) }`.
7. **No `setTimeout` anywhere in `src/`.** `test/surfaces/no-fixed-waits.test.mjs`
   enforces it by walking every source file. Use `src/runtime/converge.mjs`.
8. **The CSP is emitted through `escapeHtml`.** A probe that greps the raw policy
   string produces a false failure, the single quotes appear as `&#39;`.
9. **`converge` does not hold the Node event loop open.** It waits on
   `AbortSignal.timeout`, which is unref'd, so a standalone script that awaits
   `converge` exits early with "Detected unsettled top-level await".
   `src/cli/commands/run.mjs` already solves this with a ref'd `setInterval`
   keepalive around `runSuite`. Any new entry point that awaits convergence
   outside the test runner needs the same.
10. **Only one instance of an AVD can run at a time.** A crashed run that leaves
   an emulator booting will make the next `startEmulator` wait for a serial that
   never appears, because the second launch is refused. Check `adb devices` and
   for stray `qemu-system-x86_64*` processes before blaming the code.
11. **The fixture app has no foreign keys, deliberately.** `fixtures/self-verify/app/schema.sql`
   omits both `ON DELETE CASCADE` and the parent foreign keys. Cascade in the
   database makes the orphan bug unseedable; an enforced key blocks it a
   different way, by aborting the transaction so the scenario fails on a page
   assertion instead of on the delta, which would make the gate look like it
   caught the bug when it actually caught a crash. Do not add either back.

## Known gaps, stated rather than hidden

- `db.convergeTimeoutMs`, `db.quietPeriodMs` and `db.quietPeriodCapMs` exist in
  the config schema but do not reach the runtime: `src/lower/ops/structure.mjs`
  hardcodes the converge timeout and quiet period onto the lowered op.
  Convergence works on its defaults so DB-08 holds, but the three knobs are
  inert. Documented in `docs/database-delta.md`.
- Derived rule stats do not record `sourceCount` or `perSource` in the printed
  rule table.
- Concurrent runs against one database are unsupported rather than made safe.
  Making them safe needs slot leasing, which is a design change and deserves its
  own plan.

## Decisions that are settled, do not re-litigate

- Capture is causal (Postgres logical replication slot), not snapshot diffing.
- BigQuery will NOT support the no unexplained delta assertion. Refused at
  compile time.
- Isolation is scenario scoped tenancy. Transaction rollback is structurally
  invalid because the app under test is a separate process.
- iOS takes a zipped simulator `.app`, never a device `.ipa`.
- Mobile driver is Appium 3 plus WebdriverIO, not Maestro.
- Execution performs zero LLM calls, enforced by `tools/check-import-boundary.mjs`.
- **Android drives adb directly, not Appium** (decision C6, 2026-08-17). The old note said
  "Appium 3 plus WebdriverIO, not Maestro", but that compared Appium against Maestro and never
  considered plain adb. Full reasoning is in `.planning/REQUIREMENTS.md` under C6.

Full reasoning for each is in `.planning/REQUIREMENTS.md` under
"Adjudicated conflicts".
