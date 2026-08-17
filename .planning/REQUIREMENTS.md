# Requirements: Attest

**Defined:** 2026-08-15
**Core Value:** A run either passes or fails deterministically, and when it fails it names the exact scenario, the exact step, and the exact database rows that are wrong.

## Adjudicated conflicts

Three researchers disagreed on load bearing decisions. Resolutions are recorded here because
they constrain everything downstream.

### C1: capture strategy, CDC versus snapshot diff (RESOLVED: CDC first on Postgres)

FEATURES.md put snapshot plus diff in v1 and deferred change data capture to v2, arguing CDC
is per engine work with privilege requirements. PITFALLS.md and ARCHITECTURE.md both argue
snapshot diffing is the documented way this project fails, because a diff carries no
causality, ordering, or authorship, so every suppression rule degrades to a blunt table name
match and the differentiator gets neutered into a no op.

Resolution: the differentiator is the classifier plus the typed rule engine, which consume a
normalized `ChangeEvent` stream. How that stream is produced is a per driver capability.
Postgres ships in v1 with a logical replication slot, because Supabase grants the privilege,
Postgres covers roughly 20 of Ahmad's apps, and it is the driver that has to prove the
feature works. SQLite ships with a snapshot diff fallback. Building snapshot first and
retrofitting CDC would mean rebuilding the classifier, since a snapshot cannot express the
ordering and authorship the rule engine consumes.

### C2: mobile scope (RESOLVED: mobile is in the milestone, sequenced late)

FEATURES.md deferred the Android adapter and the iOS adapter to v1.x. Ahmad's request
explicitly named integrated, automated emulators for Android and iOS. The user's scope wins,
so both are v1 requirements. The sequencing advice is still respected: the roadmap proves the
web plus Postgres loop end to end before mobile starts, because that is where the DB
semantics get settled and mobile should not begin while they are still moving.

### C3: BigQuery delta support (RESOLVED: capability reduced, and it is explicit)

The brief said all five drivers sit behind one interface, implying uniform capability.
PITFALLS.md and ARCHITECTURE.md both establish BigQuery cannot honestly support a no
unexplained delta assertion: it is an append oriented sink written by unrelated pipelines,
the streaming buffer delays queryability, and DML against buffered rows is restricted.
BigQuery therefore declares reduced capability and gets bounded polling for expected rows
only. A scenario demanding a delta assertion on BigQuery is refused at compile time, never
silently passed.

### C4: correction to the brief, Mongo transactions

The brief claimed Mongo lacks cross collection transactions. That is wrong. Mongo supports
multi document, cross collection, cross database transactions, and change streams, but only
on a replica set or sharded cluster, never on a standalone `mongod`. The real requirement is
preflight detection of a standalone deployment and an explicit refusal, not a quiet degrade.

### C5: transaction rollback isolation does not apply here

The standard "wrap the test in a transaction and roll back" pattern is invalid for this
project. The app under test is a separate process with its own connections, so it cannot see
the harness's uncommitted data and the harness cannot roll back what the app committed.
Isolation is scenario scoped tenancy by default.

### C6: Android driver backend (RESOLVED 2026-08-17: adb direct, superseding Appium for v1)

STACK.md recommended Appium 3 plus WebdriverIO and PITFALLS.md rejected Maestro, so the recorded
decision read "Appium 3 plus WebdriverIO, not Maestro". That comparison was Appium against Maestro.
Driving adb directly was never the alternative under consideration, so this is a gap being filled
rather than a settled decision being reopened.

Resolution: the Android adapter drives adb directly for v1. The element tree comes from
`uiautomator dump` and interaction from `input tap` and `input text`, which ENV-VERIFIED already
proved working on this machine, including an addressable tree carrying `resource-id`.

Reasoning:

- It satisfies all four DROID requirements. DROID-01 boot gating, DROID-03 argv only adb, and
  DROID-04 screenshots plus screen recording plus hierarchy dump are all adb level regardless of
  driver. Only DROID-02's interaction layer was ever in question.
- Appium adds three large dependencies, a Java on PATH requirement this machine does not currently
  satisfy, and a server lifecycle to manage, against a project rule of no new dependencies unless
  a plan says so.
- The cost is real and is recorded here rather than hidden: coordinate based tapping derived from
  the dumped bounds is cruder than a W3C element click, and it is more sensitive to layout changes.

This is a v1 scope decision, not a permanent one. The adapter sits behind the same surface port and
passes the same conformance suite as the web adapter, so an Appium backed backend can replace the
interaction layer later without touching the port, the scenarios, or the bindings.

## v1 Requirements

### Scenario format and compilation

- [ ] **SCEN-01**: User writes one scenario file per flow that runs unchanged on web, Android, and iOS
- [ ] **SCEN-02**: Scenario steps use a closed op vocabulary, and an unknown op is a validation error, not a runtime surprise
- [ ] **SCEN-03**: Selectors, URLs, and platform names are rejected by the parser inside a scenario file, they are legal only in the bindings layer
- [ ] **SCEN-04**: The parser rejects `sleep`, any fixed wait, and any `if platform` branch
- [ ] **SCEN-05**: A per surface escape hatch exists, requires a written reason, and every use is counted in the run record
- [ ] **SCEN-06**: A scenario compiles to a serializable execution plan before anything launches, and `--dry-run` validates without executing
- [ ] **SCEN-07**: A scenario declares the requirement IDs it covers, so coverage is reportable against a spec
- [ ] **SCEN-08**: Compilation fails when a scenario demands a capability the target surface or DB driver does not declare

### Runner and CLI contract

- [ ] **RUN-01**: One command runs a suite and exits with a distinct code for pass, scenario failure, and harness error
- [ ] **RUN-02**: Execution performs zero LLM calls, proven by a full suite passing with no API key present in the environment
- [ ] **RUN-03**: User can filter a run by tag, by scenario id, and by surface, and can run a single scenario headed
- [ ] **RUN-04**: Every run emits a machine readable JSON run record and JUnit XML
- [ ] **RUN-05**: Scenarios carrying a delta assertion run serially by default, and parallelism is opt in only where attribution is provable
- [ ] **RUN-06**: A harness failure (emulator will not boot, DB unreachable) is reported as infrastructure error, never as a scenario failure
- [ ] **RUN-07**: Timeouts are bounded per step and per scenario, and a hung run terminates with evidence rather than hanging forever

### Web surface

- [ ] **WEB-01**: Web scenarios execute on Playwright using the `chrome` channel, not bare Chromium
- [ ] **WEB-02**: Web adapter captures screenshots at checkpoints, video, network log, and a Playwright trace on failure

### Android surface

- [x] **DROID-01**: Runner starts, boot gates, and shuts down an AVD automatically, with no manual emulator step
- [x] **DROID-02**: Android scenarios execute against an installed APK on the emulator
- [x] **DROID-03**: adb is invoked as a direct process with an argument array, never through a POSIX shell, so Git Bash path mangling cannot occur
- [x] **DROID-04**: Android adapter captures screenshots, screen recording, and the UI hierarchy on failure

### iOS surface

- [x] **IOS-01**: iOS scenarios execute on an iOS simulator on a GitHub Actions macOS runner
- [x] **IOS-02**: The iOS adapter is exercised by contract tests that run on Windows without a simulator, so it cannot silently rot between CI runs

### Database layer

- [ ] **DB-01**: All drivers sit behind one interface and each declares its capabilities explicitly
- [ ] **DB-02**: Postgres and Supabase capture changes via a logical replication slot, yielding ordered per row changes with transaction identity
- [x] **DB-03**: SQLite is supported via snapshot diff fallback, with its driver defaults pinned explicitly rather than inherited
- [x] **DB-04**: MySQL captures changes from the row format binlog
- [x] **DB-05**: Mongo captures changes via change streams, and preflight refuses a standalone deployment instead of degrading quietly
- [x] **DB-06**: BigQuery declares reduced capability, supports bounded polling for expected rows, and refuses delta assertions at compile time
- [ ] **DB-07**: A scenario's change window is fenced by watermark marker rows, not by wall clock timestamps
- [ ] **DB-08**: The runner waits for write convergence before asserting, so the race between "UI says saved" and "row is visible to another connection" cannot produce a false failure
- [ ] **DB-09**: Connection targets must be on an explicit allowlist and carry a non production marker, and an unmarked target is refused by default
- [ ] **DB-10**: Captured values are redacted and normalized before appearing in any report or artifact

### The differentiator: delta classification

- [ ] **DELTA-01**: User declares expected mutations per scenario, and missing expected mutations fail the run
- [ ] **DELTA-02**: Every captured change is classified into exactly one of expected, explained, suppressed external, or unexplained, and all four counts are printed
- [ ] **DELTA-03**: Any unexplained change fails the run by default
- [ ] **DELTA-04**: A failure names the scenario, the step, the table, the row key, and the column
- [ ] **DELTA-05**: Rules are typed, limited to volatile columns, derived, external writer, and ignore, with no free form blacklist
- [ ] **DELTA-06**: A derived rule must name its source mutation and a cardinality, so one delete explaining 47 audit rows still fails
- [ ] **DELTA-07**: An ignore rule requires a written reason and an expiry date, and an expired ignore fails the run
- [ ] **DELTA-08**: Wildcards are forbidden in ignore rules on table names
- [ ] **DELTA-09**: Every run prints per rule suppression counts, and a rule suppressing beyond its declared cardinality or an absolute cap fails the run as too broad
- [ ] **DELTA-10**: A rule that fires zero times across consecutive runs is reported as dead and proposed for deletion
- [ ] **DELTA-11**: Rules live in a versioned file and the run report includes the ruleset hash, so loosening a rule to turn a run green shows up in a diff

### Isolation and determinism

- [ ] **ISO-01**: Each scenario runs against freshly provisioned scenario scoped tenancy, and the strict delta is evaluated inside that tenant
- [ ] **ISO-02**: Seed data is declared per scenario and applied deterministically
- [ ] **ISO-03**: Re running an unchanged suite against an unchanged app produces the same verdict, demonstrated by a repeated run in CI

### Evidence and reporting

- [ ] **EVID-01**: Every run produces a self contained HTML report that opens with no server
- [ ] **EVID-02**: The report shows, per failed scenario, the step timeline, the screenshot at failure, and the classified DB delta
- [ ] **EVID-03**: Artifacts are written to a per run directory that is safe to attach to CI

### Scenario generation

- [x] **GEN-01**: Scenarios generate from existing spec docs (`.planning/`, PRD, SPEC, UI-SPEC) with each generated scenario linked to the requirement ID it covers
- [x] **GEN-02**: Generation reports which requirements have no covering scenario
- [ ] **GEN-03**: Scenarios generate by crawling a running app when specs are absent
- [x] **GEN-04**: Generated scenarios land in a proposed directory and require explicit promotion before they gate anything
- [x] **GEN-05**: Generation asserts declared intent rather than merely recording current behavior, and anything it could not ground in a spec is flagged for review

### Self verification

- [ ] **SELF-01**: A fixture app plus seeded bug corpus ships with the tool, including the orphan row on delete case already reproduced
- [ ] **SELF-02**: The suite reports a kill rate against that corpus, and a regression in kill rate fails the build
- [ ] **SELF-03**: The rule engine has its own tests independent of any app under test

### Integration

- [x] **INTEG-01**: Attest runs as an AtoZ pipeline stage conforming to the existing stage contract, and blocks the pipeline on failure
- [ ] **INTEG-02**: AtoZ gains a mobile track so a mobile app can reach verification
- [x] **INTEG-03**: Attest is callable from `/gsd:validate-phase` so a phase cannot be verified while scenarios fail

## v2 Requirements

- **DEAD-01**: Dead write detection, rows written but never read back. Needs separate read capture and is false positive prone, so it is advisory not a gate
- **PERF-01**: Checksum descend diffing for large datasets
- **SHARD-01**: Sharding with mergeable reports
- **FLAKE-01**: Flake classification and an automatic quarantine list
- **DRIFT-01**: Schema drift detection when an ignore rule silently stops matching
- **TIA-01**: Test impact analysis, run only scenarios affected by a change

## Out of Scope

| Feature | Reason |
|---------|--------|
| Load and performance testing | Different primitives, different tool |
| Visual regression pixel diffing | High maintenance, orthogonal to correctness |
| Security scanning | AtoZ already has a `sast` stage |
| Real device cloud farms | Emulators and simulators cover v1 at zero cost |
| App store automation | Blocked on the deferred Apple and Play accounts regardless |
| Hosted web UI or multi tenant SaaS | Single operator tool |
| Self healing selectors | They hide real breakage, which defeats the purpose of a gate |
| Transaction rollback isolation | Structurally invalid here, the app is a separate process (see C5) |

## Traceability

Every v1 requirement maps to exactly one phase. See `.planning/ROADMAP.md` for phase goals
and success criteria.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCEN-01 | Phase 1 | Pending |
| SCEN-02 | Phase 1 | Pending |
| SCEN-03 | Phase 1 | Pending |
| SCEN-04 | Phase 1 | Pending |
| SCEN-05 | Phase 1 | Pending |
| SCEN-06 | Phase 1 | Pending |
| SCEN-07 | Phase 1 | Pending |
| SCEN-08 | Phase 1 | Pending |
| RUN-01 | Phase 1 | Pending |
| RUN-02 | Phase 1 | Pending |
| RUN-03 | Phase 1 | Pending |
| RUN-04 | Phase 1 | Pending |
| RUN-05 | Phase 3 | Pending |
| RUN-06 | Phase 1 | Pending |
| RUN-07 | Phase 1 | Pending |
| WEB-01 | Phase 2 | Pending |
| WEB-02 | Phase 2 | Pending |
| DROID-01 | Phase 5 | Done |
| DROID-02 | Phase 5 | Done |
| DROID-03 | Phase 5 | Done |
| DROID-04 | Phase 5 | Done |
| IOS-01 | Phase 7 | Done, unproven until the first CI run |
| IOS-02 | Phase 7 | Done |
| DB-01 | Phase 3 | Pending |
| DB-02 | Phase 3 | Pending |
| DB-03 | Phase 6 | Done |
| DB-04 | Phase 6 | Done |
| DB-05 | Phase 6 | Done |
| DB-06 | Phase 6 | Done |
| DB-07 | Phase 3 | Pending |
| DB-08 | Phase 3 | Pending |
| DB-09 | Phase 3 | Pending |
| DB-10 | Phase 3 | Pending |
| DELTA-01 | Phase 3 | Pending |
| DELTA-02 | Phase 3 | Pending |
| DELTA-03 | Phase 3 | Pending |
| DELTA-04 | Phase 3 | Pending |
| DELTA-05 | Phase 3 | Pending |
| DELTA-06 | Phase 3 | Pending |
| DELTA-07 | Phase 3 | Pending |
| DELTA-08 | Phase 3 | Pending |
| DELTA-09 | Phase 3 | Pending |
| DELTA-10 | Phase 3 | Pending |
| DELTA-11 | Phase 3 | Pending |
| ISO-01 | Phase 3 | Pending |
| ISO-02 | Phase 3 | Pending |
| ISO-03 | Phase 4 | Pending |
| EVID-01 | Phase 2 | Pending |
| EVID-02 | Phase 3 | Pending |
| EVID-03 | Phase 1 | Pending |
| GEN-01 | Phase 6 | Done |
| GEN-02 | Phase 6 | Done |
| GEN-03 | Phase 6 | Deferred, crawler not built, quarantine is |
| GEN-04 | Phase 6 | Done |
| GEN-05 | Phase 6 | Done |
| SELF-01 | Phase 4 | Pending |
| SELF-02 | Phase 4 | Pending |
| SELF-03 | Phase 4 | Pending |
| INTEG-01 | Phase 7 | Adapter done, mounting is AtoZ's call |
| INTEG-02 | Phase 7 | Prepared, the decision is AtoZ's |
| INTEG-03 | Phase 7 | Hook done, wiring is GSD's call |

**Per phase totals:**

| Phase | Requirements |
|-------|--------------|
| Phase 1: Scenario Compiler and Run Contract | 15 |
| Phase 2: Web Surface and Evidence Bundle | 3 |
| Phase 3: Database Capture and the Delta Engine | 21 |
| Phase 4: Self Verification | 4 |
| Phase 5: Android Surface | 4 |
| Phase 6: Remaining Drivers and Scenario Generation | 9 |
| Phase 7: iOS on CI and the Pipeline Gate | 5 |

**Coverage:**
- v1 requirements: 61 total
- Mapped to phases: 61
- Unmapped: 0
- Duplicated across phases: 0

---
*Requirements defined: 2026-08-15*
*Traceability populated: 2026-08-15 during roadmap creation*
