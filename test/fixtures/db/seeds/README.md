# Database Seed Fixtures

Seed declarations are data files, not SQL scripts. A scenario names a seed with
`data.seed`, and the harness loads rows from this directory, applies them inside
the scenario tenant, and records the canonical seed digest for reproducibility.

Expected shape:

```yaml
name: catalog
entities:
  - entity: public.products
    tenantColumn: tenant_key
    rows:
      - sku: one
        name: Widget
        price_cents: 1200
```

Rows are inserted with parameterized statements. Nondeterministic markers such
as `$random`, `$uuid`, and `$now` are refused at load time.
