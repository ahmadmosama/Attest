# Attest: resume here

Written 2026-08-17 at the end of a long build session. Working tree is clean,
everything below is committed.

## Where it stands

| Thing | State |
|---|---|
| Phases done | 2 of 7 (Phase 1 and Phase 2 complete) |
| Phase in progress | Phase 3, waves 1 to 5 of 7 done and committed |
| Tests | 590 passing, 0 failing, 0 skipped |
| Verified against | real PostgreSQL 17.6 and real Chrome, not mocks |
| Last commit | `4160aea feat(03-13)` |

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
(PostgreSQL 17.6, `wal_level=logical` already set, published on host port 54322).

## What is left

| Phase | Scope |
|---|---|
| 3 (remaining) | wave 6: plan 03-14 reporting. wave 7: plan 03-15 CLI wiring, driver registry, phase acceptance, docs |
| 4 | self verification, fixture app, seeded mutant corpus, kill rate. **Phase 3 cannot be signed off until this reports a kill rate** |
| 5 | Android surface on the emulator, plus the milestone demo |
| 6 | SQLite, MySQL, Mongo, BigQuery drivers, plus scenario generation |
| 7 | iOS on macOS CI, AtoZ pipeline stage, GSD hook |

Plans for the rest of Phase 3 already exist at
`.planning/phases/03-database-capture-and-the-delta-engine/03-14-PLAN.md` and
`03-15-PLAN.md`. Phases 4 to 7 are in `.planning/ROADMAP.md` and need
`/gsd:plan-phase N` before execution.

## How the work has been running

Claude plans and verifies. Codex implements, one plan per call:

```bash
cd "C:/Users/ahmad/Desktop/Claude/Attest" && node "C:/Users/ahmad/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs" task --write --cwd "C:/Users/ahmad/Desktop/Claude/Attest" --effort high "<self contained spec>"
```

Plans within the same wave have zero `files_modified` overlap, so they can run
concurrently. Only one plan per wave may touch `package.json`.

## Things that will bite you if forgotten

1. **Test discovery is one glob on purpose.** `node --test "test/**/*.test.mjs"`
   discovers all 79 files. A split light/heavy glob was tried and found only 34
   of 78, silently hiding 44 from the gate. Do not split it, do not add
   `test/index.mjs`, do not add `test/package.json`. That file previously
   declared a `main` and hijacked discovery down to 4 files.
2. **Concurrency is capped at 2 with a 120s per test timeout.** The heavy tests
   spawn child processes and launch Chrome. At the default concurrency of 8 on
   this 8 core box they intermittently timed out. They pass in isolation, so it
   was contention, not logic.
3. **Replication slots are a disk risk.** An unconsumed logical slot makes
   Postgres retain WAL indefinitely. Always verify after a DB run:
   ```bash
   docker exec attest_pg_local psql -U postgres -tAc "SELECT coalesce(string_agg(slot_name,', '),'NONE') FROM pg_replication_slots;"
   ```
   Expect `NONE`. Same for `attest%` tables, schemas and roles.
4. **Machine memory is the real constraint.** Free RAM hit 1.0 GB of 16.9 GB
   during this session, which is what pushed Chrome over its timeouts. The local
   Supabase stack runs 9 containers and only `supabase_db` is needed. Stopping
   the other 8 frees roughly 890 MB. `a-pipeline-critical-service` must stay up, it is daily
   pipeline critical.
5. **No `setTimeout` anywhere in `src/`.** `test/surfaces/no-fixed-waits.test.mjs`
   enforces it by walking every source file. Use `src/runtime/converge.mjs`.

## Decisions that are settled, do not re-litigate

- Capture is causal (Postgres logical replication slot), not snapshot diffing.
  Proven working, see `.planning/ENV-VERIFIED.md`.
- BigQuery will NOT support the no unexplained delta assertion. Reduced
  capability, bounded polling only, refused at compile time.
- Isolation is scenario scoped tenancy. Transaction rollback is structurally
  invalid because the app under test is a separate process.
- iOS takes a zipped simulator `.app`, never a device `.ipa`.
- Mobile driver is Appium 3 plus WebdriverIO, not Maestro. Maestro runs fine on
  Windows, it was rejected because it cannot be stepped per step from Node.
- Execution performs zero LLM calls, enforced by `tools/check-import-boundary.mjs`.

Full reasoning for each is in `.planning/REQUIREMENTS.md` under
"Adjudicated conflicts".
