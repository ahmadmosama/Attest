# Database Delta

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
