# Attest: resume here

Updated 2026-08-17. Working tree is clean, everything below is committed.

## Where it stands

| Thing | State |
|---|---|
| Phases done | 5 of 7 complete, Phase 6 planned and started |
| Phase 3 | Complete and SIGNED OFF, with a 90.91 percent kill rate |
| Phase 5 | Complete. Four criteria proven against a live emulator, real APK, real Postgres |
| Milestone | Landed. One command runs one real app on the Android emulator and leaves an evidence bundle |
| Tests | 843 total, 840 passing, 0 failing. The 3 skips are the live Android criteria with no device attached |
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
| 6 | SQLite, MySQL, Mongo, BigQuery drivers, plus scenario generation | 7 of 8, acceptance remains |
| 7 | iOS on macOS CI, AtoZ pipeline stage, GSD hook | Not planned |

### Phase 6, where it actually is

Planned: eight plans in four waves, in `.planning/phases/06-remaining-drivers-and-generation/`.

Done:
- **06-01**, target resolution and the registry for all five engines. `postgres`, `mysql`,
  `mongo`, `sqlite` and `bigquery` all resolve to typed targets under the same DB-09 allowlist
  and non production rule, and the four unimplemented ones are refused by name, each naming the
  plan that lands it. Summary in `06-01-SUMMARY.md`.
- **06-02**, the SQLite driver, DB-03. Snapshot diff capture behind the same port, driver
  defaults pinned explicitly, an observer connection that physically cannot write, and the three
  things a diff cannot see proven by committed tests rather than described. The degradation
  reaches the operator through the CLI banner, every close result, and a new `database` block in
  run.json. 30 tests, no server needed. Summary in `06-02-SUMMARY.md`.

- **06-05**, BigQuery, DB-06 and conflict C3. `deltaAssertion: false` makes the compile time
  refusal structural, proven by lowering a real scenario against the real descriptor. Bounded
  polling, an opt in and a hard byte budget behind an injected client seam. 17 tests.
- **06-04**, Mongo, DB-05 and correction C4. Change streams, the cleanest signal of the five:
  ordering, transaction attribution and per field updates from `updateDescription`. A standalone
  mongod is refused by name with `--replSet` as the fix. Marker documents fence the window. 29
  tests.
- **06-03**, MySQL, DB-04. ROW format binlog capture. STATEMENT and MIXED refused with the
  `SET GLOBAL` fix, binary log off refused, missing replication grant refused,
  `binlog_row_image` MINIMAL degraded and printed. 28 tests.

**All five engines are now behind one interface**, and `DB_DRIVER_MODES` reports every one as
implemented.

- **06-06 and 06-07**, generation, GEN-01, GEN-02, GEN-04 and GEN-05. A spec declares what a
  requirement means in an ```attest block; prose never becomes steps, and a requirement stated
  only in prose is reported uncovered. Everything emitted compiles through the real compiler
  first. Quarantine is three layers: the glob, a `proposed: true` marker in the file and in the
  IR, and a runner that refuses it wherever found. Promotion checks compile plus requirement and
  shows up in a diff. 28 tests. Summary in `06-06-SUMMARY.md`.

**The import boundary caught the first version of this** and the fix is worth knowing about:
`attest generate` as a subcommand created three edges from `src/cli` into `src/generate`, which
RUN-02 forbids. There are now two binaries. `attest` runs, `attest-generate` authors, and the
process that runs scenarios never loads the generator at all.

Next, in order:
1. **GEN-03, the crawler**, which is the one thing 06-07 did not land. The quarantine and
   promotion machinery it needs is built and tested, so it drops into an existing safety net.
2. **06-08, acceptance and docs**, which is also where the live halves land.

Three things 06-08 has to reconcile, all now concrete rather than predicted:

- **`poll` returns different shapes per driver.** SQLite, Mongo and MySQL return
  `{ok, events, converge}`; BigQuery returns `{ok, rows, converge}` because it has no events to
  return. One has to win, or the port has to say both are legal and why.
- **No new driver is exercised through a full `attest run`**, because the fixture app is Postgres
  shaped.
- **Three drivers have no live proof at all.** MySQL, Mongo and BigQuery keep their clients behind
  injected seams because plan 03-04 makes every dependency install a blocking human checkpoint
  that is explicitly never auto approvable. Their parsers and refusals are fixture proven and run
  anywhere; what is unproven is that real client responses match the shapes the code expects.
  Installing `@vlasky/zongji`, `mongodb` and `@google-cloud/bigquery`, and running one live window
  each, is the remaining work and needs that checkpoint plus a MySQL, a replica set and a GCP
  project.

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
