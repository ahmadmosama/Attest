/*
  The fixture intentionally omits ON DELETE CASCADE, and it also omits the
  parent foreign keys entirely. Both omissions exist for the same reason.

  Phase 4 needs the delete cascade to live in application code so that a mutant
  can skip part of it and leave orphaned orders and order items behind for
  Attest to catch. ON DELETE CASCADE would perform the cleanup in the database,
  which makes the bug unseedable. An enforced foreign key blocks it a different
  way: deleting a customer whose orders still exist would abort the transaction,
  the app would return a server error, and the scenario would fail on a page
  assertion instead of on the delta. The gate would look like it caught the bug
  while actually having caught a crash, which is not the same claim.

  Referential integrity is therefore modelled in application code here on
  purpose. That is also the realistic case: orphan rows on delete are a common
  production bug precisely because many real schemas do not enforce these keys.
*/

CREATE TABLE IF NOT EXISTS customers (
  tenant_key text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (tenant_key, id)
);

CREATE TABLE IF NOT EXISTS orders (
  tenant_key text NOT NULL,
  id text NOT NULL,
  customer_id text NOT NULL,
  status text NOT NULL,
  total_cents integer NOT NULL,
  PRIMARY KEY (tenant_key, id)
);

CREATE TABLE IF NOT EXISTS order_items (
  tenant_key text NOT NULL,
  order_id text NOT NULL,
  line_number integer NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL,
  unit_cents integer NOT NULL,
  PRIMARY KEY (tenant_key, order_id, line_number)
);

CREATE TABLE IF NOT EXISTS order_audit (
  tenant_key text NOT NULL,
  id text NOT NULL,
  order_id text NOT NULL,
  action text NOT NULL,
  detail text NOT NULL,
  PRIMARY KEY (tenant_key, id)
);

ALTER TABLE customers REPLICA IDENTITY FULL;
ALTER TABLE orders REPLICA IDENTITY FULL;
ALTER TABLE order_items REPLICA IDENTITY FULL;
ALTER TABLE order_audit REPLICA IDENTITY FULL;
