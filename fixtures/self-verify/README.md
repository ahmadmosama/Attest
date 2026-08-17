# Self Verify Fixture

This fixture is the reference app for Phase 4 self verification. It is a small HTTP app backed by the same Postgres target used by Phase 3, so Attest can drive a real web surface and inspect real database changes.

The fixture has known correct behavior. Deleting a customer must delete that customer's orders and order items, and must write one `order_audit` row for each deleted order. The schema deliberately does not use `ON DELETE CASCADE`: the cascade lives in application code so the mutant corpus can seed the orphan order bug by removing that application work.

The seed in `app/seed.mjs` is declared data, not generated data. Its digest is computed with `src/db/seed.mjs`, and the same seed applied to a fresh tenant must produce the same starting rows every time.

For manual debugging, point `ATTEST_PG_URL` and `ATTEST_DB_URL` at a non production Postgres target, import `startFixtureApp` from `fixtures/self-verify/app/server.mjs`, and call it with a resolved target plus a plain lowercase schema name. The server listens on port `0` and returns the assigned URL.

Changing the fixture's correct behavior invalidates the recorded mutant kill rate baseline. The app behavior and the baseline must move together in the same review.
