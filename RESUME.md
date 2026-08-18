# Attest: resume here

Updated 2026-08-18. Working tree is clean, everything below is committed.

## Where it stands

| Thing | State |
|---|---|
| Phases done | 7 of 7. All plans executed |
| Phase 3 | Complete and SIGNED OFF, with a 90.91 percent kill rate |
| Phase 5 | Complete. Four criteria proven against a live emulator, real APK, real Postgres |
| Milestone | Landed. One command runs one real app on the Android emulator and leaves an evidence bundle |
| Tests | 1029 total, 1026 passing, 0 failing. The 3 skips are the live Android criteria with no device attached |
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
| 6 | SQLite, MySQL, Mongo, BigQuery drivers, plus scenario generation | Complete, GEN-03 crawler deferred |
| 7 | iOS on macOS CI, AtoZ pipeline stage, GSD hook | Adapters complete, mounting is AtoZ's and GSD's call |

### Phase 6, complete with two stated gaps

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

- **06-08**, acceptance and docs. Five criteria, six tests, all running with no server and no
  credentials. `docs/drivers.md` carries the per engine capability table and a live proof status
  table; `docs/generation.md` carries the generation rules. A test compares the documented table
  against the descriptors the drivers actually return, so the docs cannot drift into fiction.

**Two gaps Phase 6 did not close, both deliberate:**

1. **GEN-03, the crawler.** Not built. Its safety net is built and tested, so it drops into an
   existing quarantine rather than needing one built around it. What is missing: driving the web
   adapter within a step budget, refusing destructive looking actions, and emitting ungrounded
   assertions commented out with a review report.
2. **MySQL, Mongo and BigQuery have no live proof**, because plan 03-04 makes every dependency
   install a blocking human checkpoint that is explicitly never auto approvable. Their clients sit
   behind injected seams. Installing `@vlasky/zongji`, `mongodb` and `@google-cloud/bigquery` and
   running one live window each needs that checkpoint plus a MySQL, a replica set and a GCP
   project.
### Phase 7, where it actually is

Planned: three plans, in `.planning/phases/07-ios-on-ci-and-the-pipeline-gate/`.

Done:
- **07-01**, the iOS adapter, IOS-02. Built on Windows where it cannot run, and fully exercised
  there: it is the fourth name in the conformance suite alongside fake, android and web. Both
  portable locator strategies map to `accessibilityIdentifier` rather than the translated label.
  Two capabilities declared, and simctl can do more, deliberately. 23 tests.
- **07-02**, the workflows, IOS-01. `ios.yml` on `macos-26` with Xcode and the runtime both
  pinned, the runtime asserted before the suite starts, the simulator shut down in an always
  step, and no `continue-on-error` anywhere, asserted by a test that parses the file.
  `check.yml` runs the gate on ubuntu and windows with a real Postgres, which is DROID-03's
  second half.

- **07-03**, the integration, INTEG-01 and INTEG-03. The AtoZ stage is built to the contract's
  SHAPE and imports nothing from AtoZ, with a test that reads the source to prove it; even the
  BlockerError is duck typed. The GSD hook treats a requirement with no covering scenario as
  unverified, because a hook that only reported on scenarios that exist would let an untested
  phase sail through with borrowed authority. 11 tests. Summary in `07-03-SUMMARY.md`.

## After the phases: two things that were missing

### The iOS driver is real now (2026-08-18)

`simctl` boots, installs and launches. It has no accessibility tree and no tap, so the surface
could start an app and then not touch it: the adapter's `describeElements`, `tap` and `type` seams
were injected with a note saying they came "from the CI harness", and no harness existed.

They are filled by [`facebook/idb`](https://github.com/facebook/idb), picked the way the Android
driver was, by asking what actually exists. 5.3k stars, pushed the week it was evaluated, not
archived, MIT. One binary, argv only, no server to host per run, and a tree carrying `AXUniqueId`.
It is the iOS analogue of adb, so the two mobile surfaces are now one idea twice rather than two.
The alternatives and why each lost are in `docs/ios.md`.

`src/surfaces/ios/idb.mjs` spawns nothing, so all of it is asserted here against a transcript of
real idb output. `ios.yml` installs both halves (`idb-companion` is the native process, `fb-idb`
is the CLI that talks to it) and asserts `describe-all` succeeds against the booted device before
the suite runs.

### It holds when a run is interrupted (2026-08-18)

An audit of what leaks on an abrupt exit found ten things, and the worst was not any single leak:
there were already **two** signal handler registries, in the slot layer and the tenancy layer,
each ending in `process.exit`. Whichever settled first killed the other's cleanup, so a Ctrl-C
during a run holding both reliably leaked one.

`src/runtime/cleanup.mjs` is now the one registry: reverse order, bounded per disposer, one
failure never skips the rest, a second Ctrl-C abandons and exits. It registers slots, tenants, the
surface registry (the emulator, the one leak that breaks the *next* run) and web sessions.

`run.json` is claimed up front with an `in_progress` marker that becomes `interrupted` on a
signal, so a killed run reports that rather than reporting nothing, and the pipeline stage blocks
under `verify_interrupted`. Every artifact write is temp file plus rename.

Nothing catches SIGKILL, so the sweeps matter as much as the registry, and two were broken: the
slot sweep ran with `keep: []` (a hazard waiting for someone to raise concurrency) and
`sweepStaleTenants` was written and never called. Both fixed.

Full contract, including what it deliberately does not cover: `docs/interruption.md`.

## What is genuinely left

Every plan across all seven phases has been executed. What remains is work that needs something
this machine does not have, or a decision that belongs to another project:

1. **Mount the AtoZ stage.** `docs/integration.md` carries the exact three change diff. It goes
   after `review` and before `deploy`, which is the hole it fills. AtoZ's call.
2. **Wire the GSD hook** into `/gsd:validate-phase`. GSD's call.
3. **INTEG-02, the AtoZ mobile track.** Prepared, and the decision is AtoZ's: it means deciding
   what `build` and `deploy` mean for a mobile app.
4. **The first iOS CI run.** There is no macOS here, so `ios.yml` is unproven until it runs once.
   The idb command layer and its normalisation are proven here against a committed transcript;
   what is unproven is idb reaching a live companion and a tap landing on a real app.
5. **Live proof for MySQL, Mongo and BigQuery**, which needs the 03-04 dependency checkpoint plus
   a MySQL, a replica set and a GCP project.
6. **GEN-03, the crawler.** Its safety net is built and tested.
7. **The device side `screenrecord` on an abrupt kill.** The host side adb child is registered
   with the cleanup registry; the process on the emulator keeps running to its 180s limit and
   leaves an unfinalised `.mp4` on `/sdcard`. There is no sweep for it.

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
15. **Register anything that must be released with `src/runtime/cleanup.mjs`.** Do not add a
    second set of signal handlers; that was the bug, not the fix. Use `release()` when the normal
    path is tearing the resource down right now, and `dispose()` when you want the registry to do
    it. Both are idempotent because the two paths race by construction.
16. **Node does not deliver SIGTERM on Windows.** Ctrl-C works, `taskkill` without `/F` does not.
    A cleanup test that sends SIGTERM will pass on CI and prove nothing here, which is why
    `test/acceptance/interrupt.test.mjs` uses `process.emit("SIGINT")` for the catchable case and
    a real `SIGKILL` for the uncatchable one.
17. **A bare absolute path is not importable on Windows.** The ESM loader reads `C:` as a URL
    scheme. Any spawned `--eval` child importing from `src/` needs `pathToFileURL`.

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
