# test_decoding golden fixtures

These fixtures were captured from the local PostgreSQL server, not hand written.

Server used during capture:

- Docker container: `attest_pg_local`
- PostgreSQL version: 17.6
- Plugin: `test_decoding`
- Rows were selected as `lsn || '|' || xid || '|' || data`

The fixture files cover:

- `insert-delete.txt`: one transaction with inserts and deletes.
- `update-full.txt`: an update after `REPLICA IDENTITY FULL`, producing `old-key` and `new-tuple`.
- `update-default.txt`: an update with default replica identity, producing an after tuple only.
- `delete-no-tuple-data.txt`: a deliberate degraded delete with `(no-tuple-data)`.

To recapture, create scratch `public.attest_td_0307_*` tables, create a uniquely named logical slot
with `SELECT * FROM pg_create_logical_replication_slot(slot_name, 'test_decoding')`, run the mutation,
then write `SELECT lsn, xid, data FROM pg_logical_slot_get_changes(slot_name, NULL, NULL)` as pipe
delimited rows.

Always drop the slot after draining it:

`SELECT pg_drop_replication_slot(slot_name);`

Always drop the scratch tables after capture.

Verify cleanup before finishing:

`SELECT slot_name FROM pg_replication_slots WHERE slot_name LIKE 'attest%';`

`SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'attest_td_0307_%';`

Both cleanup queries should return zero rows.
