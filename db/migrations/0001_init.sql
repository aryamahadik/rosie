-- 0001_init (D-000): migration bookkeeping and the extensions later migrations need. Nothing product-specific.
-- infra/scripts/migrate.mjs runs this file in one transaction and records it in schema_migrations.

-- One row per applied migration file, in each schema migrated (public on staging, preview_<slug> per preview).
create table if not exists schema_migrations (
  version text primary key check (version ~ '^[0-9]{4}$'),
  name text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
);

-- The extensions live in public, so every schema sees them and no preview schema owns one:
-- postgis for places and distances, btree_gist for EXCLUDE constraints that mix equality with ranges,
-- pgcrypto for gen_random_bytes and digest.
create extension if not exists postgis with schema public;
create extension if not exists btree_gist with schema public;
create extension if not exists pgcrypto with schema public;
