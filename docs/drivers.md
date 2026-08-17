# Database Drivers

Five engines, one interface, and each declares what it can honestly observe. A green run on one
engine is not the same evidence as a green run on another, and this page is where you find out
which one you are looking at.

Every row below is the descriptor the driver actually returns. `test/acceptance/phase-06.test.mjs`
compares this table's claims against the live descriptors, so it cannot drift into fiction.

## What each engine can observe

| | Postgres | MySQL | Mongo | SQLite | BigQuery |
|---|---|---|---|---|---|
| capture | logical slot | ROW binlog | change stream | snapshot diff | none |
| delta assertion | yes | yes | yes | yes | **no** |
| bounded polling | yes | yes | yes | yes | yes |
| ordering | yes | yes | yes | **no** | no |
| transaction attribution | yes | yes | yes | **no** | no |
| watermark fencing | inline | inline | inline | external | none |
| before images | full | full when `binlog_row_image=FULL` | only with pre images on | full | none |

`delta assertion` is the one that matters most. It is what lets a scenario say "and nothing else
changed". BigQuery cannot answer that question, so it declares `false`, and the compiler refuses a
scenario that asks. See conflict C3 in `.planning/REQUIREMENTS.md`.

## What each engine refuses, and the fix

A refusal is always better than a quiet degrade. Every one of these produces an `InfraError` with
a remediation, before the run starts.

| Engine | Refusal | Error | Fix |
|---|---|---|---|
| Postgres | `wal_level` is not logical | `E_PG_WAL_LEVEL` | set `wal_level=logical` and restart |
| Postgres | transaction pooler port 6543 | `E_DB_POOLER_PORT` | use the direct session connection on 5432 |
| MySQL | binary log off | `E_MYSQL_BINLOG_DISABLED` | start `mysqld --log-bin` |
| MySQL | STATEMENT or MIXED format | `E_MYSQL_BINLOG_FORMAT` | `SET GLOBAL binlog_format=ROW` |
| MySQL | no replication grant | `E_MYSQL_REPLICATION_PRIVILEGE` | `GRANT REPLICATION SLAVE, REPLICATION CLIENT` |
| Mongo | standalone mongod | `E_MONGO_STANDALONE` | start with `--replSet` and `rs.initiate()`, or use Atlas |
| Mongo | no changeStream privilege | `E_MONGO_CHANGE_STREAM_PRIVILEGE` | grant `changeStream` and `find` |
| SQLite | file does not exist | `E_SQLITE_FILE_MISSING` | point `db.url` at the file the app writes |
| SQLite | entity is not a plain identifier | `E_SQLITE_IDENTIFIER_INVALID` | fix the entity name in config |
| BigQuery | delta assertion demanded | `E_DELTA_UNSUPPORTED`, at compile time | assert expected rows instead |
| BigQuery | no credentials | `E_BIGQUERY_CREDENTIALS_MISSING` | ADC or `GOOGLE_APPLICATION_CREDENTIALS` |
| BigQuery | query without opt in | `E_BIGQUERY_QUERY_NOT_ENABLED` | set `db.bigquery.allowQuery` |
| BigQuery | dry run over the byte budget | `E_BIGQUERY_BYTE_BUDGET` | narrow the query, or raise the budget deliberately |
| any | target not on the allowlist | `E_DB_TARGET_NOT_ALLOWLISTED` | add it, with `nonProd: true` |

The allowlist and the non production marker apply to **every** engine, including SQLite. A local
file path is a target like any other, and pointing a run at a production sqlite file is exactly as
bad as pointing it at a production Postgres.

## The SQLite blind spot, in the words the run prints

SQLite has no change stream, so capture is a snapshot pair. Three things follow, and the run
states all three on every close:

```text
sqlite capture is snapshot diff, not a change stream
no ordering: changes within a window carry no sequence
no attribution: changes carry no transaction or author
no round trips: an insert then delete, or a value changed and changed back, is invisible
```

The third is the one that bites. A row inserted and deleted inside one window is absent from both
snapshots, so nothing is emitted, and that is exactly the case a delta engine exists to catch.
`test/db/drivers/sqlite/blind-spot.test.mjs` proves it rather than describing it.

What SQLite *can* see, it sees exactly: a net change carries its full before and after row, which
is what makes four bucket classification meaningful there at all.

## Where the degradation shows up

Three places, so it cannot be missed:

1. the CLI banner, one `degraded:` line per claim, on every run
2. every `closeWindow` result, as `warnings`
3. `run.json`, in the `database` block, with driver, capture, ordering, attribution and the list

## Live proof status, stated plainly

| Engine | Parsers and refusals | Live against a real server |
|---|---|---|
| Postgres | proven | **proven**, PostgreSQL 17.6, Phase 3 acceptance |
| SQLite | proven | **proven**, real files written by a second connection |
| MySQL | proven, fixture based | not yet |
| Mongo | proven, fixture based | not yet |
| BigQuery | proven, fixture based | not yet |

The last three keep their clients behind injected seams. Plan 03-04 makes every new dependency a
blocking human verification before install, and its threat model states that checkpoint is never
auto approvable, so `@vlasky/zongji`, `mongodb` and `@google-cloud/bigquery` are not installed.
`E_MYSQL_CLIENT_MISSING`, `E_MONGO_CLIENT_MISSING` and `E_BIGQUERY_CLIENT_MISSING` name the seam
rather than pretending to connect.

What that leaves unproven is narrow and specific: that a real client's responses match the shapes
these parsers expect. The fixtures follow the documented formats, which is a good substitute and
not a conclusive one.
