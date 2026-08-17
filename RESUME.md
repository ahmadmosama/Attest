# Attest: resume here

Updated 2026-08-17. Working tree is clean, everything below is committed.

## Where it stands

| Thing | State |
|---|---|
| Phases done | 5 of 7 complete, Phase 6 planned and started |
| Phase 3 | Complete and SIGNED OFF, with a 90.91 percent kill rate |
| Phase 5 | Complete. Four criteria proven against a live emulator, real APK, real Postgres |
| Milestone | Landed. One command runs one real app on the Android emulator and leaves an evidence bundle |
| Tests | 810 passing, 0 failing, 0 skipped with a device attached, plus 11 added since that run |
| Verified against | real PostgreSQL 17.6, real Chrome, and a real Android emulator |

## Run the gate

```bash
cd "C:/Users/ahmad/Desktop/Claude/Attest"
export ATTEST_PG_URL="postgres://postgres:postgres@127.0.0.1:54322/postgres"
export ATTEST_DB_URL="$ATTEST_PG_URL"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
npm run check
```

Without `ATTEST_PG_URL` the Postgres tests skip cleanly. Without a device attached the live
Android criteria skip and print exactly what was not proven. Both skips state a reason; neither
is a way to dodge a failure.

Requires Docker running, container `attest_pg_local` (PostgreSQL 17.6,
`wal_level=logical`, host port 54322). Only that one container is needed. `a-pipeline-critical-service` must stay
up, it is daily pipeline critical.

For the live Android half:

```bash
node tools/build-fixture-apk.mjs                       # offline, ~6s
"$ANDROID_HOME/emulator/emulator.exe" -avd attest_pixel7_a35 -no-boot-anim &
until [ "$("$ANDROID_HOME/platform-tools/adb.exe" shell getprop sys.boot_completed | tr -d '\r\n')" = "1" ]; do sleep 5; done
```

## Run the self verification

```bash
node src/cli/main.mjs selfcheck
```

```text
Mutants: killed 10, survived 1, errored 0, total 11
Kill rate: 90.91% (0.9090909090909091)
Baseline: 90.91% (0.9090909090909091)
```

The single survivor, `survivor_create_audit_detail`, is a declared known blind spot recorded in
the corpus with its reason. A corpus that scores 100 percent by construction measures nothing.

`--update-baseline` is the only way the recorded rate moves.

## The milestone demo

Reproduced 2026-08-17. Full transcript, including the failure path and the independent psql
verification, is in `docs/android.md` under "The milestone demo".

```bash
node src/cli/main.mjs run \
  --scenarios "examples/mobile-demo/scenarios/*.attest.yaml" \
  --bindings examples/mobile-demo/bindings \
  --surface android \
  --app .attest/fixture/attest-selfverify.apk \
  --android-package attest.selfverify \
  --android-activity .MainActivity \
  --android-serial emulator-5554 \
  --android-extra "attest_api_base=http://10.0.2.2:<fixture port>"
```

## What is left

| Phase | Scope | State |
|---|---|---|
| 6 | SQLite, MySQL, Mongo, BigQuery drivers, plus scenario generation | Planned, 8 plans, 06-01 done |
| 7 | iOS on macOS CI, AtoZ pipeline stage, GSD hook | Not planned |

### Phase 6, where it actually is

Planned: eight plans in four waves, in `.planning/phases/06-remaining-drivers-and-generation/`.

Done:
- **06-01**, target resolution and the registry for all five engines. `postgres`, `mysql`,
  `mongo`, `sqlite` and `bigquery` all resolve to typed targets under the same DB-09 allowlist
  and non production rule, and the four unimplemented ones are refused by name, each naming the
  plan that lands it. Summary in `06-01-SUMMARY.md`.
- **06-02, first half**: `src/db/capture/snapshot-diff.mjs`, the engine neutral snapshot diff,
  with 11 tests. A changed column is one update rather than a delete plus an insert, a duplicate
  declared key is refused, output is deterministic in key order, and the blind spot is a named
  export rather than a comment.

Next, in order:
1. `src/db/drivers/sqlite/`, the driver itself: openWindow snapshots, closeWindow snapshots and
   diffs, the capability descriptor declaring `capture: "snapshot"` with no ordering and no
   attribution, and the degraded mode printed on every run. Flip `DB_DRIVER_MODES.sqlite` to
   implemented, which the registry test already requires a mode for.
2. 06-03 MySQL, 06-04 Mongo, 06-05 BigQuery. Each is independent of the others.
3. 06-06 and 06-07, generation. 06-08, acceptance and docs.

### Phase 6, what it needs

Nine requirements: DB-03 to DB-06 and GEN-01 to GEN-05. The four drivers are independent of
each other and of the generator, so this phase parallelises. SQLite first because it needs no
server, BigQuery last because it is the reduced mode. Generation is evaluated against the Phase
4 mutant corpus, not by whether the output looks reasonable. Nothing under the runtime may
import from the generator, and the Phase 1 lint rule already proves it.

Phase 5 left two things Phase 6 and Phase 7 inherit:

- The device lease pattern in `src/surfaces/android/device.mjs`: a run scoped resource acquired
  once, refused honestly when ambiguous, and torn down in a `finally` in the run command. iOS
  simulators want the same shape.
- `test/helpers/fake-adb.mjs`: a scripted transport that answers the real argv, so the adapter's
  own logic executes with no device. The same seam works for `simctl`.

## Things that will bite you if forgotten

1. **Test discovery is one glob on purpose.** `node --test "test/**/*.test.mjs"` discovers all
   files. A split light/heavy glob was tried and found only 34 of 78, silently hiding 44 from
   the gate. Do not split it, do not add `test/index.mjs`, do not add `test/package.json`.
2. **Never let a test skip itself to dodge a failure.** Legitimate skips: no database reachable,
   no device attached, or a capability the adapter does not declare. Each must state a reason.
3. **One Attest run at a time against a database.** A logical slot polled with
   `pg_logical_slot_get_changes` reads as inactive between polls, so a concurrent run's orphan
   sweep drops it. A run whose slot was swept captures nothing, and a window that captured
   nothing has no unexplained changes, so it can report pass. The suite serialises its Postgres
   tests with `withPostgresSlotLock`.
4. **Concurrency is capped at 2 with a 120s per test timeout.** The heavy tests spawn child
   processes, launch Chrome, and drive an emulator.
5. **Replication slots are a disk risk.** Always verify after a DB run:
   ```bash
   docker exec attest_pg_local psql -U postgres -tAc "SELECT coalesce(string_agg(slot_name,', '),'NONE') FROM pg_replication_slots;"
   ```
   Expect `NONE`. Also check no leftover schemas (`attest_phase0%`, `sv_%`, `p5%`).
   `attest.watermark` with 0 rows is expected and correct.
6. **Machine memory is the real constraint.** Committed memory sits near 89 percent of 31.4 GB.
   The emulator takes about 2 GB on top. Sweep zombie shells before a long run.
7. **No `setTimeout` anywhere in `src/`.** `test/surfaces/no-fixed-waits.test.mjs` enforces it.
   Use `src/runtime/converge.mjs`.
8. **The CSP is emitted through `escapeHtml`.** A probe that greps the raw policy string
   produces a false failure, the single quotes appear as `&#39;`.
9. **`converge` does not hold the Node event loop open.** It waits on `AbortSignal.timeout`,
   which is unref'd, so a standalone script that awaits `converge` exits early with "Detected
   unsettled top-level await". `src/cli/commands/run.mjs` solves it with a ref'd `setInterval`
   keepalive. Any new entry point needs the same.
10. **Only one instance of an AVD can run at a time.** A crashed run that leaves an emulator
    booting makes the next `startEmulator` wait for a serial that never appears. Check
    `adb devices` and for stray `qemu-system-x86_64` processes before blaming the code.
11. **The fixture app has no foreign keys, deliberately.** Cascade in the database makes the
    orphan bug unseedable, and an enforced key blocks it a different way. Do not add either back.
12. **An Android tap is fire and forget.** `input tap` returns before the app has done anything,
    and a change window's close marker is written before the close converges, so an app write
    that lands after the marker falls outside the fence. A scenario must assert the app's own
    outcome between the action and the window close. This cost a debugging cycle on 2026-08-17.
13. **Attest does not model z order.** A node under an ActionBar or other overlay still reports
    its own bounds, so the tap lands on the overlay. The fixture uses `NoActionBar` because of it.
14. **Node refuses to spawn a `.bat` without a shell.** `d8` and `apksigner` ship as `.bat`
    wrappers, so `tools/build-fixture-apk.mjs` calls the jars they wrap directly.

## Known gaps, stated rather than hidden

- `db.convergeTimeoutMs`, `db.quietPeriodMs` and `db.quietPeriodCapMs` exist in the config
  schema but do not reach the runtime: `src/lower/ops/structure.mjs` hardcodes the converge
  timeout and quiet period onto the lowered op. Convergence works on its defaults so DB-08
  holds, but the three knobs are inert.
- Derived rule stats do not record `sourceCount` or `perSource` in the printed rule table.
- Concurrent runs against one database are unsupported rather than made safe. Making them safe
  needs slot leasing, which is a design change and deserves its own plan.
- `adb screenrecord` stops at 180 seconds. A longer scenario keeps the first 180 seconds and the
  artifact records `truncated: true`. Chunking is not implemented.
- The Android adapter declares no network, permission, clipboard or clock control. Each absence
  is stated with a reason in `docs/android.md` rather than faked.
- The milestone demo drives the CLI without a delta window, because coordinating the fixture
  server's tenant key with the runtime's tenancy needs the programmatic harness. The delta half
  is proven by criterion 2 of `test/acceptance/phase-05-android.test.mjs`.

## Decisions that are settled, do not re-litigate

- Capture is causal (Postgres logical replication slot), not snapshot diffing.
- BigQuery will NOT support the no unexplained delta assertion. Refused at compile time.
- Isolation is scenario scoped tenancy. Transaction rollback is structurally invalid because the
  app under test is a separate process.
- iOS takes a zipped simulator `.app`, never a device `.ipa`.
- **Android drives adb directly, not Appium** (decision C6, 2026-08-17). It sits behind the same
  surface port and passes the same conformance suite, so an Appium backed interaction layer can
  replace it later without touching the port, the scenarios or the bindings.
- Execution performs zero LLM calls, enforced by `tools/check-import-boundary.mjs`.
- The fixture APK is built without Gradle, from the installed SDK build tools. A cold Gradle
  build resolves the Android Gradle Plugin from Google Maven, and a fixture whose job is
  determinism must not need the network.

Full reasoning for each is in `.planning/REQUIREMENTS.md` under "Adjudicated conflicts", and for
Phase 5 specifically in `.planning/phases/05-android-surface/05-08-SUMMARY.md`.

## How the work has been running

Claude plans and verifies. Codex implements, one plan per call.

**Codex hit its ChatGPT usage limit on 2026-08-17 and resets 2026-08-22.** Until then, implement
directly in Claude. The fallback is expected and is written into the routing rule, it is not a
failure state. All of Phase 5 was implemented this way.

After each chunk: run the gate, verify the load bearing claims by an independent probe rather
than trusting the test output, check for leaked replication slots, commit.
