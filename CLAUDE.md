<!-- GSD:project-start source:PROJECT.md -->
## Project

**Attest**

A QA verification harness. Point it at an app (web URL, Android `.apk`, or a zipped iOS
simulator `.app`, never a device `.ipa`, the simulator cannot install one) plus
a database, and it proves the app behaves as specified across every scenario, and proves
the database ended up in exactly the state it should, with nothing extra and nothing
missing. It is a CLI first, and it plugs into the `A to Z Deployment` pipeline as the
verification stage that pipeline currently lacks.

Built for Ahmad, to gate his own portfolio apps and his work systems before they ship.

**Core Value:** A run either passes or fails deterministically, and when it fails it names the exact
scenario, the exact step, and the exact database rows that are wrong. If everything else
fails, that must work: a gate nobody trusts is worse than no gate.

### Constraints

- **Platform**: iOS simulator cannot run on Windows. The iOS adapter is built locally but
  only ever executed on GitHub Actions macOS runners. Not deferred, just relocated.
- **Tech stack**: Node. Playwright is already present and is the strongest web driver.
  Android via the local SDK toolchain that is now proven working.
- **Determinism**: no LLM in the execution path. An LLM that flakes turns a merge gate into
  a coin flip, which would make the tool worthless for its one job.
- **Git identity**: personal only, `ahmadmosama <ahmadmosama@gmail.com>`. Local repo, no
  remote, never pushed. The work account must never touch git here. Hard boundary, non negotiable.
- **Secrets**: DB connection strings live in env or `.env`, never committed, never placed
  in a Codex prompt.
- **Work scope**: Work-environment support is configuration only. No work credentials in the repo, no
  work code copied in, nothing work related pushed anywhere.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Headline answers to the five questions
## The Maestro on Windows question, answered definitively
| Claim | Source | Confidence |
|---|---|---|
| Native Windows install exists: download `maestro.zip` from GitHub releases, extract to `C:\maestro`, add `bin` to PATH | [docs.maestro.dev install page](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli) | HIGH |
| Maestro **recommends against** WSL: "Although it is possible to run the Maestro CLI on WSL, Maestro recommends using one of the other supported environments (macOS, Windows, or Linux). The WSL setup requires advanced port configuration, which can introduce issues" | same page, verbatim quote | HIGH |
| Native Windows support shipped in CLI 1.39.9, changelog entry "Fix: Enable running Maestro on Windows without WSL", plus a follow up fix for emulator discovery on Windows | Maestro changelog and release announcement | MEDIUM (search sourced, changelog wording confirmed twice) |
| Current release is `cli-2.8.0`, published 2026-07-31, single asset `maestro.zip` at 314 MB | [GitHub releases API](https://api.github.com/repos/mobile-dev-inc/maestro/releases/latest) queried live | HIGH |
| Maestro 2.x requires Java 17+ and switched the JS engine from Rhino to GraalJS | [Maestro 2.0.0 blog](https://maestro.dev/blog/introducing-maestro-2-0-0) | HIGH |
| Web flow support exists but is explicitly "at its early stages", and web flows now key off `url` instead of `appId` | same blog | HIGH |
- **Format collision.** Maestro's YAML is itself a scenario language. Attest owns the scenario language. Building Attest on Maestro means compiling YAML into YAML and inheriting Maestro's semantics, its `appId` model, and its breaking changes.
- **Runtime weight.** Java 17+ dependency and a 314 MB distribution in the critical path of a CLI whose stated implementation language is Node.
- **Web parity is a mirage.** Maestro web is early stage by its own admission and would be strictly worse than driving Playwright directly, so the "one tool for all three surfaces" argument does not actually pay out.
## Recommended Stack
### Core Technologies
| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 24.13.0 (pinned, already installed) | Runtime | Meets Appium 3's floor of `>=24.0.0`, ships `node:sqlite` and stable ESM, and native TS type stripping removes a build step in dev |
| TypeScript | 7.0.2 | Types for the scenario schema, adapters and DB layer | 7.0 is the stable Go native compiler, roughly 8x to 12x faster full builds. Typecheck only, Attest does not need the compiler's programmatic API. See the caveat below |
| `playwright` | 1.62.1 | Web adapter | Still the correct and dominant answer. Already installed. Use the library API so Attest owns the runner |
| `appium` | 3.6.0 | Mobile automation server (Android on Windows, iOS on macOS CI) | Only mainstream option that exposes a per step W3C protocol from Node, runs its server on a Windows host, and covers native, React Native and Flutter. Appium 3 requires Node `^20.19 \|\| ^22.12 \|\| >=24` |
| `webdriverio` | 9.30.1 | W3C client that talks to Appium from Node | Gives an ergonomic, promise based per step API (`$()`, `click`, `setValue`, `getPageSource`, `takeScreenshot`, `startRecordingScreen`) that maps one to one onto Playwright's shape, which is exactly what "one scenario format, adapters per surface" needs |
| `appium-uiautomator2-driver` | 8.4.0 | Android automation backend | The standard Android driver. Runs against the already verified `android-35;google_apis;x86_64` AVD |
| `appium-xcuitest-driver` | 12.3.4 | iOS automation backend | The standard iOS driver. Installed and exercised only on macOS CI |
| `zod` | 4.4.3 | Scenario schema, config schema, DB expectation schema | Already the validation library in Ahmad's codebase. Zod 4 ships first party `z.toJSONSchema()`, so one schema produces TS types, runtime validation and editor autocomplete |
| `yaml` | 2.9.0 | Scenario file parsing | Chosen over `js-yaml` specifically for `parseDocument` plus `LineCounter`, which lets a validation error point at the exact line and column in the scenario file. A gate that says "line 37, col 5: unknown step type" is materially better than one that says "invalid scenario" |
### Database Layer
| Library | Version | Engine | Why this one |
|---------|---------|--------|--------------|
| `pg` | 8.23.0 | Postgres and Supabase | The mature, boring choice. Supabase is Postgres, so connect over the raw Postgres wire protocol. Streaming cursors and `COPY` support matter for snapshotting |
| `pg-copy-streams` | 7.0.0 | Postgres | Optional. `COPY ... TO STDOUT` is by far the fastest way to pull a full table snapshot when a table genuinely has to be materialised |
| `mysql2` | 3.23.3 | MySQL and MariaDB | The only actively maintained Node MySQL driver worth using. Native promise API, prepared statements, streaming rows |
| `node:sqlite` | built in (Node 24, Stability 1.2 Release candidate, no flag) | SQLite | **Zero install and zero native compilation.** On a Windows host this matters a lot: it removes the `prebuild-install` and MSVC failure mode entirely. Also exports a `Session` class for changeset tracking, which is directly useful for diffing |
| `better-sqlite3` | 13.0.3 | SQLite fallback | Only if `node:sqlite` proves insufficient. It is synchronous, fast and battle tested, but it is a native addon and reintroduces the Windows toolchain risk |
| `@google-cloud/bigquery` | 9.0.2 | BigQuery | The official client. Auth via ADC or a service account JSON path from env, no API key in the repo |
| `mongodb` | 7.5.0 | Mongo | The official driver. Change streams give the cheapest "what changed" signal when a replica set is available |
- `@supabase/supabase-js` (2.112.3). It talks to PostgREST, not to Postgres. It cannot run arbitrary SQL, cannot read `pg_stat_user_tables`, is subject to RLS in ways that will silently hide rows from the diff, and its row shapes are JSON coerced. For an assertion engine that must prove "nothing unexplained changed", reading through an API that can hide rows is disqualifying. Use `pg` with the Supabase connection string. Prefer the direct connection (port 5432, session mode) over the transaction mode pooler on 6543, because session level features like temp tables, advisory locks and `LISTEN` are needed and pgbouncer transaction mode breaks them.
- An ORM or query builder (`kysely` 0.29.5, `knex` 3.3.0, Prisma, Drizzle). Attest reads schemas it does not own and does not control. Generated SQL against foreign schemas is a liability, and none of these help with the actual hard part which is efficient change detection. Write the SQL, per dialect, deliberately.
### Snapshot and Diff Strategy
| Engine | Primitive | Notes and caveats |
|---|---|---|
| Postgres | `pg_stat_user_tables` (`n_tup_ins`, `n_tup_upd`, `n_tup_del`), delta before vs after | Cumulative stats moved into shared memory in PG 15, so they are far more current than the old stats collector file era, but they are still not transactionally instant. Call `pg_stat_clear_snapshot()` before each read because stats are cached per transaction, and set `stats_fetch_consistency` deliberately. Counters are **server wide**, so a noisy neighbour on the same database pollutes them. Fine on a controlled test database, unreliable against shared staging. MEDIUM confidence, verify empirically in phase 1 |
| MySQL | `performance_schema.table_io_waits_summary_by_table` (`COUNT_INSERT`, `COUNT_UPDATE`, `COUNT_DELETE`) | The direct analogue. Requires `performance_schema` enabled, which is on by default. `information_schema.TABLES.UPDATE_TIME` is the tempting alternative and is unreliable for InnoDB, do not use it |
| SQLite | `PRAGMA data_version` for "did another connection commit", plus `PRAGMA schema_version`. `node:sqlite`'s `Session` class produces a real changeset | Cheapest of the five. SQLite databases in Ahmad's estate are small enough that tier 1 can be skipped entirely if it complicates things |
| Mongo | Change streams (`db.watch()`) when a replica set is present, which is always true on Atlas and requires `--replSet` locally | The cleanest signal of the five, because it is an actual event log rather than a counter. Fall back to per collection count plus hash when standalone |
| BigQuery | `__TABLES__.last_modified_time`, `INFORMATION_SCHEMA.PARTITIONS.last_modified_time`, and `INFORMATION_SCHEMA.JOBS` for the DML that ran | **Never full table scan BigQuery, it is billed per byte scanned.** Treat BigQuery as append mostly, diff by partition and by job, and require an explicit opt in plus a byte budget before any query that scans data |
- Postgres: `SELECT sum(hashtext(t::text)::bigint), count(*) FROM tbl t` (order independent, single pass), or an ordered `md5(string_agg(md5(t::text), '' ORDER BY pk))` when a stable primary key exists and exact ordering is wanted.
- MySQL: `SELECT sum(cast(conv(substring(md5(concat_ws('\x1f', ...)),1,16),16,10) as unsigned)), count(*)`.
- SQLite and Mongo: hash in Node, the volumes do not justify engine side work.
| Library | Version | Purpose |
|---|---|---|
| `json-stable-stringify` | 1.3.0 | Deterministic key ordering for the canonical serialiser. Small enough to inline instead if a dependency is unwanted |
| `microdiff` | 1.6.0 | Fast, zero dependency structural diff for producing the human readable "field X went from A to B" in the report. Not for the hot path, only for rendering |
### Evidence Capture
| Surface | Screenshots | Video | Network | Confidence |
|---|---|---|---|---|
| Web | `page.screenshot()` per step | `browser.newContext({ recordVideo: { dir, size } })` | `browser.newContext({ recordHar: { path, content: 'embed', mode: 'full' } })` plus `page.on('request'/'response')` for live assertions | HIGH, all confirmed available on the plain library API, no `@playwright/test` needed |
| Web (bonus) | `context.tracing.start({ screenshots: true, snapshots: true, sources: true })` then `tracing.stop({ path })` | produces a single trace zip viewable offline via `npx playwright show-trace` | included in the trace | HIGH |
| Android | `driver.takeScreenshot()` per step | `driver.startRecordingScreen()` (uiautomator2, backed by `adb screenrecord`) | local MITM proxy, see below | HIGH on screenshots, MEDIUM on video, `adb screenrecord` has a hard 180 second segment limit that the driver works around by chunking, verify empirically |
| Android (logs) | `mobile: shell` with `logcat`, or `adb logcat -d` via `execa` | | | HIGH |
| iOS | `driver.takeScreenshot()` | `driver.startRecordingScreen()` (xcuitest, needs `ffmpeg` on the runner, `brew install ffmpeg` in the workflow) | proxy plus simulator trust store | MEDIUM |
### Reporting
- `allure-playwright` 3.10.2 is bound to the `@playwright/test` runner, and Attest is not using that runner.
- Generating the Allure HTML report requires the Allure CLI, which is a JVM tool. That drags Java back into a Node CLI's critical path for the *report*, on top of already needing it if Maestro were used.
- Allure's data model has no first class notion of a database diff. Attest's single differentiator would be demoted to an opaque attachment, which defeats the purpose.
### Scenario Format
| Option | Verdict | Reasoning |
|---|---|---|
| **YAML validated by zod, JSON Schema emitted for editors** | **Adopt** | Scenarios are machine generated and human reviewed. YAML diffs cleanly in a PR, which matters because generated scenarios are reviewed before they become a gate. Parsing is inert: a scenario file can never execute code, which is essential when the file was written by an LLM. `z.toJSONSchema()` (built into zod 4, no `zod-to-json-schema` dependency) emits a draft 2020-12 schema that VS Code picks up via `yaml.schemas`, giving autocomplete and inline errors while authoring |
| TS DSL | Reject | A `.ts` scenario means `import()`ing and executing arbitrary code that an LLM wrote, inside the process that gates merges. That is an arbitrary code execution surface in a security gate. It also breaks the "same file drives three surfaces" story, because a TS DSL invites platform specific escape hatches. It diffs worse and it cannot be validated without running it |
| JSON | Reject as the authoring format | No comments, no multiline strings, painful to hand edit. Keep JSON as the *internal* representation that YAML compiles into, and accept `.json` scenarios as an input format for machine producers |
| CUE / JSON Schema authored by hand | Reject | Second schema language to maintain, and it would not be zod, so TS types would need separate generation. Zod 4 already produces both directions |
### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `commander` | 15.0.0 | CLI argument parsing and subcommands | `attest run`, `attest generate`, `attest devices`, `attest report`. Boring, stable, zero surprises. `citty` 0.2.2 is lighter but less proven for a multi command CLI |
| `execa` | 10.0.1 | Spawning `adb`, `emulator.exe`, `gradle`, optional `maestro` | Cross platform argument escaping is the reason. Windows `.exe` resolution and quoting is exactly where hand rolled `child_process` breaks |
| `p-limit` | 7.3.1 | Bounded concurrency for parallel scenarios and parallel DB table snapshots | Keeps emulator and connection pool pressure sane |
| `dotenv` | 17.4.2 | Load DB connection strings from `.env` | Never commit, never pass into a Codex prompt, per project constraints |
| `mockttp` | 4.6.0 | MITM proxy for mobile network capture | Android and iOS network evidence |
| `microdiff` | 1.6.0 | Structural diff rendering | Report layer only |
| `json-stable-stringify` | 1.3.0 | Canonical serialisation before hashing | DB row fingerprinting |
| `picocolors` | 1.1.1 | Terminal colour | 7x smaller and faster than chalk, no ESM drama |
| `cli-table3` | 0.6.5 | Terminal summary table | The pass/fail summary printed at the end of a run |
| `xmlbuilder2` | 4.0.3 | JUnit XML emission | Only if `junit-report-builder` proves too opinionated |
| `tinyglobby` | 0.2.17 | Scenario file discovery | Modern, tiny replacement for `fast-glob`, which is now in maintenance |
### Development Tools
| Tool | Version | Purpose | Notes |
|------|---------|---------|-------|
| `vitest` | 4.1.10 | Attest's own unit and integration tests | Fast, ESM native, does not need the TypeScript programmatic API so TS 7 is not a problem |
| `testcontainers` + `@testcontainers/postgresql` | 12.1.0 | Ephemeral Postgres, MySQL and Mongo for testing the DB adapters | Requires Docker Desktop. Note from memory: this ThinkPad has hit a BIOS VT-x reset trap before, and Docker is already carrying critical containers. Gate this behind an opt in test tag so the default `npm test` never needs Docker |
| `tsdown` | 0.22.14 | Bundle the CLI for distribution | Rolldown and oxc based, the current successor to `tsup` 8.5.1. Use `tsup` if `tsdown` proves unstable at 0.x |
| `esbuild` | 0.28.2 | Bundle the report's client side renderer into one inline script | Separate from the CLI bundle, different target |
| `oxlint` | 1.78.0 | Linting | Rust based, does not depend on the TypeScript compiler API, so it sidesteps the TS 7.0 programmatic API gap entirely. `@biomejs/biome` 2.5.8 is the equivalent alternative and also does formatting |
| `@faker-js/faker` | 10.6.0 | Deterministic test data with a fixed seed | Seed it explicitly, an unseeded faker makes runs non reproducible which violates the core constraint |
## Installation
# Core: web + mobile drivers
# Database layer (node:sqlite is built in, nothing to install)
# Scenario format + validation
# Runtime support
# Evidence: mobile network capture
# Reporting
# Dev
# Optional, only if Allure export is wanted later
# npm install allure-js-commons@3.10.2
# Optional secondary mobile adapter, not required
# Download maestro.zip from https://github.com/mobile-dev-inc/maestro/releases (cli-2.8.0),
# extract to C:\maestro, add C:\maestro\bin to PATH. Requires Java 17+.
## Alternatives Considered
| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| Appium 3 + WebdriverIO | **Maestro 2.8.0** | If the mobile scenarios are simple whole flow smoke tests with no mid flow DB assertion, Maestro is dramatically faster to author and reportedly under 1 percent flaky. Worth adding as an optional secondary adapter so existing Maestro flows can be executed by Attest. Not the core because it cannot be stepped from Node |
| Appium 3 + WebdriverIO | **Detox 20.51.4** | Only if Attest's scope ever narrows to pure React Native. Detox's grey box synchronisation genuinely gives the lowest flakiness (under 2 percent) because it hooks the RN bridge and knows when the app is idle. But it does not support Flutter, does not support web, and requires building the app under test with Detox native dependencies, which means Attest could not point at an arbitrary prebuilt `.apk`. Disqualifying given Ahmad has both Expo and Flutter apps |
| `playwright` library API | `@playwright/test` runner | If Attest were web only. It is not, and its runner has to own the DB and mobile lifecycle |
| `node:sqlite` | `better-sqlite3` 13.0.3 | If `node:sqlite`'s Release candidate status (Stability 1.2) causes real friction, or if a feature like custom collations or extension loading is needed. Accept the native build cost on Windows |
| `pg` | `postgres` 3.4.9 (porsager) | Nicer tagged template API and faster on some benchmarks, but `pg` has the deeper ecosystem for the things Attest needs (`pg-copy-streams`, cursors, type parser overrides). Type parser control matters a lot for canonical row hashing |
| Custom HTML report | Allure via `allure-js-commons` | If Attest results need to land in an existing Allure dashboard. Add as an exporter, never as the primary |
| YAML + zod | `@sinclair/typebox` 0.34.52 | If runtime validation throughput ever became a bottleneck (TypeBox compiles to raw JS validators and is substantially faster than zod). It will not be, scenario files are tiny |
| `uiautomator2` for Flutter | `appium-flutter-integration-driver` 2.0.3 | If a Flutter app under test lacks accessibility semantics. Since Flutter 3.19, `SemanticsProperties.identifier` maps to `resource-id` on Android and `accessibilityIdentifier` on iOS, so a well built Flutter app is drivable by plain uiautomator2 and xcuitest, which is what you want for black box testing of a release build. Reach for the Flutter driver (which needs a Dart VM connection and a debug build) only when semantics are missing |
## What NOT to Use
| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@supabase/supabase-js` for DB assertions | Talks to PostgREST, cannot run arbitrary SQL, subject to RLS row hiding, coerces types. An assertion engine that can be silently shown fewer rows than exist is worthless | `pg` against the Postgres connection string |
| Supabase transaction mode pooler (port 6543) | pgbouncer transaction mode breaks temp tables, advisory locks, `LISTEN`, prepared statement reuse and session scoped settings, all of which the snapshot layer wants | Direct connection on 5432, or the session mode pooler |
| Maestro as the primary mobile adapter | Whole flow JVM subprocess, no per step hook for DB snapshots, its own competing YAML dialect, Java 17 dependency, 314 MB distribution, plus a contested but open Windows file lock regression in 2.6.x | Appium 3 + WebdriverIO, keep Maestro as an optional secondary |
| Maestro under WSL | Maestro's own docs recommend against it and cite advanced port configuration problems. Native Windows works | Native Windows install of `maestro.zip`, if Maestro is used at all |
| Detox | React Native only. No Flutter, no web, requires instrumenting the app build so Attest could not test an arbitrary prebuilt binary | Appium 3 |
| `js-yaml` | No practical line and column reporting from the parsed value, so scenario validation errors cannot point at the offending line | `yaml` 2.9.0 with `parseDocument` plus `LineCounter` |
| `zod-to-json-schema` (third party) | Superseded. Zod 4 has `z.toJSONSchema()` built in and it is the maintained path | `z.toJSONSchema()` |
| Any ORM in the DB layer | Attest reads foreign schemas it does not own. Generated SQL against a schema you did not define is a correctness liability, and no ORM helps with the actual hard part (cheap change detection) | Hand written SQL per dialect behind one `DbAdapter` interface |
| `JSON.stringify` for row hashing | Key order is insertion order, so two identical rows fetched via different queries hash differently and produce phantom diffs | Canonical normaliser per driver plus `json-stable-stringify`, then sha256 |
| Full table scans against BigQuery | Billed per byte scanned. A nightly full snapshot of an analytics dataset is a real money leak | Partition metadata plus `INFORMATION_SCHEMA.JOBS`, with an explicit opt in and a byte budget |
| `http-mitm-proxy` 1.1.0 | Effectively unmaintained for the Android CA injection story | `mockttp` 4.6.0 |
| `information_schema.TABLES.UPDATE_TIME` (MySQL) | Unreliable and cached for InnoDB, will produce false negatives which is the worst possible failure mode for a gate | `performance_schema.table_io_waits_summary_by_table` |
| Unseeded `@faker-js/faker` | Non reproducible runs directly violate the determinism constraint | Explicit seed, recorded in `run.json` |
| An expression evaluator in the scenario format (`vm`, `expr-eval`, `jsonata`) | Reintroduces non determinism and arbitrary code execution into a security gate that ingests LLM generated files | Structured comparison operators in the schema |
## Stack Patterns by Variant
- Web via Playwright, headed or headless, works today.
- Android via Appium 3 server on the Windows host, `uiautomator2` driver, against the verified `attest_pixel7_a35` AVD. WHPX acceleration confirmed working, `emulator -accel-check` returns 0.
- iOS is simply not runnable. `attest run --surface ios` must fail fast with a clear message pointing at the CI workflow, never silently skip. A silently skipped surface is how a gate becomes a lie.
- All five DB adapters work locally.
- `runs-on: macos-26` (generally available since 2026-02-26, and `macos-latest` began pointing at `macos-26` on 2026-06-15). Runs natively on Apple Silicon with x64 also supported.
- iOS simulator runtimes are preinstalled on the image, so no per run download. Caveat: there has been at least one image where Xcode shipped ahead of its matching simulator runtime (issue #13853, Xcode 26.4 RC present, iOS 26.4 runtime missing). **Pin the Xcode version explicitly with `xcode-select` rather than trusting the default**, and assert the runtime exists with `xcrun simctl list runtimes` before the suite starts.
- `brew install ffmpeg` in the workflow if iOS video evidence is wanted.
- Use `ubuntu-latest`, not `windows-latest`. `reactivecircus/android-emulator-runner` documents Linux (with KVM) and macOS, and Windows runners are not supported for hardware accelerated emulation. GitHub enabled nested virtualisation for hardware accelerated Android on Linux runners in April 2024, so Ubuntu plus the KVM udev step is the fast path. Alternatively run on `macos-26` alongside the iOS job.
- This is a genuine asymmetry worth writing down: Android runs locally on Windows and in CI on Linux. The Android adapter must not encode any Windows only path assumption.
- The stage reads `run.json`, not the HTML. Blocking decision comes from a single `status` field.
- Emit JUnit XML alongside so GitHub's checks UI shows failing scenarios inline.
- Every runtime dependency above is offline capable. None of them call a model.
- Enforce it mechanically: a CI job that runs the full suite with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GEMINI_API_KEY` unset, plus an outbound allowlist assertion in the test harness. Do not rely on the absence of an import.
## Version Compatibility
| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `appium@3.6.0` | Node `^20.19.0 \|\| ^22.12.0 \|\| >=24.0.0` | Node 24.13.0 qualifies. npm 10+ required, 11.6.2 installed |
| `appium@3.x` | `appium-uiautomator2-driver@8.4.0`, `appium-xcuitest-driver@12.3.4` | Drivers are separate installs since Appium 2 and remain so in 3. Appium 3 removed many deprecated endpoints and now requires namespaced feature flags, for example `uiautomator2:adb_shell` instead of `adb_shell`. Pass `--allow-insecure` with the namespaced form |
| `webdriverio@9.30.1` | `appium@3.6.0` | Both speak W3C WebDriver. WDIO 9 is the current major |
| `playwright@1.62.1` | Node 18+ | Already installed and verified |
| `node:sqlite` | Node 24 only via that Node's build | Stability 1.2 Release candidate, no flag needed since v22.13 / v23.4. Pin the Node version in `.nvmrc` and in CI so the module's surface cannot shift under the harness |
| `typescript@7.0.2` | `vitest@4.1.10`, `tsdown@0.22.14`, `esbuild@0.28.2` | All three transform TS without the compiler's programmatic API, so TS 7 is safe with them. `typescript-eslint` is NOT compatible until the API lands in 7.1, use `oxlint` or `biome` |
| `zod@4.4.3` | JSON Schema draft 2020-12 | `z.toJSONSchema()` defaults to draft 2020-12. `z.fromJSONSchema()` exists but is explicitly experimental and outside the stable API, do not depend on it |
| `maestro cli-2.8.0` (optional) | Java 17+ | 2.x switched Rhino to GraalJS and dropped Java 16 and below. Windows file lock regression reported against 2.6.0 and 2.6.1, 2.5.1 is the known good pin |
| `mockttp@4.6.0` | Android `google_apis` and AOSP emulator images | Rootable via `adb root`, so a system CA can be injected. Does NOT work on `google_apis_playstore` images. Ahmad's `android-35;google_apis;x86_64` is on the correct side |
## Explicitly Unverified, Flagged for a Spike
| Claim | Why it matters | How to settle it |
|---|---|---|
| Maestro 2.6.x Windows file lock bug (#3414) is universal vs environment specific | Only matters if Maestro is adopted as a secondary adapter | Install `cli-2.8.0`, run one trivial flow against the AVD. 15 minutes |
| `pg_stat_user_tables` deltas are timely enough to be a reliable tier 1 filter | If stale, tier 1 produces false negatives, which is the worst failure mode for a gate | Phase 1 spike: write, immediately read stats with `pg_stat_clear_snapshot()`, measure lag. If unreliable, drop tier 1 for Postgres and go straight to tier 2 checksums on a configured table allowlist |
| `adb screenrecord` 180 second chunking through `startRecordingScreen` | Long scenarios would silently lose video | Record a 5 minute scenario, inspect the output |
| mockttp system CA injection on `android-35;google_apis;x86_64` | Determines whether HTTPS bodies land in the evidence bundle or only metadata | Spike against one real app before promising it |
| PostgreSQL 15 moved cumulative stats into shared memory | Affects how much to trust tier 1 | Read the PG 15 release notes directly. Stated here at MEDIUM confidence |
| `tsdown` at 0.x for a shipped CLI | 0.x semver means breaking changes on minors | Try it, fall back to `tsup` 8.5.1 if it churns |
## Sources
- npm registry, queried live 2026-08-15 for every version in this document. HIGH confidence on all version numbers.
- [GitHub releases API, mobile-dev-inc/maestro](https://api.github.com/repos/mobile-dev-inc/maestro/releases/latest): `cli-2.8.0`, published 2026-07-31, single 314 MB `maestro.zip` asset. HIGH.
- [Maestro CLI install docs](https://docs.maestro.dev/maestro-cli/how-to-install-maestro-cli): native Windows install, WSL discouraged verbatim, Java 17+ requirement. HIGH.
- [Maestro 2.0.0 release blog](https://maestro.dev/blog/introducing-maestro-2-0-0): Java 17, GraalJS, web support early stage, `url` replaces `appId` for web. HIGH.
- [Maestro issue #3414](https://github.com/mobile-dev-inc/maestro/issues/3414): Windows file lock regression, open, contested by a maintainer. HIGH on the report existing, LOW on whether it is universal.
- [Appium 3 requirements](https://appium.io/docs/en/latest/quickstart/requirements/): macOS, Linux, Windows hosts supported, Node `>=24.0.0` accepted. HIGH.
- [Appium 3 migration guide](https://appium.io/docs/en/latest/guides/migrating-2-to-3/): namespaced insecure feature flags, removed endpoints, Node floor. MEDIUM, search sourced summary.
- [Playwright Browser.newContext API](https://playwright.dev/docs/api/class-browser#browser-new-context): `recordHar` (`content`, `mode`, `urlFilter`), `recordVideo` (`dir`, `size`), all on the plain library API. HIGH.
- [Node.js 24 sqlite docs](https://nodejs.org/docs/latest-v24.x/api/sqlite.html): "Stability: 1.2 - Release candidate", no flag since v22.13 / v23.4, exports `DatabaseSync`, `StatementSync`, `Session`, `SQLTagStore`. HIGH.
- [Zod JSON Schema docs](https://zod.dev/json-schema): `z.toJSONSchema()` first party in v4, draft 2020-12 default, `z.fromJSONSchema()` experimental. HIGH.
- [HTTP Toolkit Android interception guide](https://httptoolkit.com/docs/guides/android/) and [Android 14 system CA post](https://httptoolkit.com/blog/android-14-install-system-ca-certificate/): `google_apis` and AOSP emulator images are rootable and support system CA injection, `google_apis_playstore` excluded. MEDIUM.
- [ReactiveCircus/android-emulator-runner README](https://github.com/ReactiveCircus/android-emulator-runner/blob/main/README.md) and [GitHub changelog on hardware accelerated Android virtualisation](https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/): Linux with KVM and macOS supported, Windows runners not. MEDIUM.
- [macos-26 generally available](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/), [macos-latest moves to macos-26](https://github.com/actions/runner-images/issues/14167), [Xcode vs simulator runtime mismatch #13853](https://github.com/actions/runner-images/issues/13853). MEDIUM to HIGH.
- [TypeScript 7.0 release coverage, InfoQ](https://www.infoq.com/news/2026/08/typescript-7-released/): stable Go native compiler, 8x to 12x faster, no stable programmatic API until 7.1. MEDIUM.
- [PostgreSQL statistics collector docs](https://www.postgresql.org/docs/12/monitoring-stats.html) plus [AWS deep dive on PG statistics](https://aws.amazon.com/blogs/database/understanding-statistics-in-postgresql/): stats are not instantaneous. MEDIUM, and the PG 15 shared memory change is stated at MEDIUM and flagged for verification.
- [Appium Flutter Driver README](https://github.com/appium/appium-flutter-driver/blob/main/README.md): since Flutter 3.19, `SemanticsProperties.identifier` surfaces as `resource-id` and `accessibilityIdentifier`, so plain uiautomator2 and xcuitest can drive a well built release Flutter app. MEDIUM.
- [Maestro vs Appium vs Detox 2026 comparison](https://codersera.com/blog/maestro-vs-appium-vs-detox-2026/) and [Drizz comparison](https://www.drizz.dev/post/detox-vs-appium-vs-maestro-which-mobile-testing-framework-in-2026): flakiness figures (Maestro under 1 percent, Detox under 2 percent RN only, Appium 15 to 20 percent), Detox is React Native only. LOW to MEDIUM, these are vendor adjacent blogs and the flakiness numbers should be treated as directional, not as measurements.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
