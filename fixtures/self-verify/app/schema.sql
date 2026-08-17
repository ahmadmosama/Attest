/*
  The fixture intentionally omits ON DELETE CASCADE.
  Phase 4 needs the delete cascade in application code so a mutant can leave
  orphaned orders and order items for Attest to catch.
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
  PRIMARY KEY (tenant_key, id),
  CONSTRAINT orders_customer_fk
    FOREIGN KEY (tenant_key, customer_id)
    REFERENCES customers (tenant_key, id)
);

CREATE TABLE IF NOT EXISTS order_items (
  tenant_key text NOT NULL,
  order_id text NOT NULL,
  line_number integer NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL,
  unit_cents integer NOT NULL,
  PRIMARY KEY (tenant_key, order_id, line_number),
  CONSTRAINT order_items_order_fk
    FOREIGN KEY (tenant_key, order_id)
    REFERENCES orders (tenant_key, id)
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
