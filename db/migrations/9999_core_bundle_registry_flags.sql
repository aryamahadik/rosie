-- T-185: the bundle registry, PostgreSQL's copy of each bundle value, and the release flags
-- (K-04 v1 core, frozen: contracts/db-schema/core). Expand only: three new tables, new triggers and indexes on them.
-- Uses enforce_version_raise() from 0002 (T-181).
-- Row-level security scope is "none" for all three tables (bundles are every business's playbook; flags are the
-- release's), so no policy is needed here.
--
-- No foreign key waits for a later migration: bundle_values points at bundles, made here. Later tables (turns,
-- open_questions, outbox_rows, event_log) point at bundles; those keys are added by the migrations that make them.

-- The bundle registry: every published bundle, keyed on K-01's bundle id {hash, build}, with at most one active.
create table bundles (
  hash text not null,
  build integer not null,
  manifest_key text not null,
  built_at timestamptz not null,
  published_at timestamptz not null default now(),
  active boolean not null default false,
  activated_at timestamptz,
  version integer not null default 1,
  primary key (hash, build),
  constraint bundles_manifest_key_key unique (manifest_key),
  constraint bundles_hash_form check (hash ~ '^[0-9a-f]{64}$'),
  constraint bundles_build_positive check (build >= 1),
  constraint bundles_manifest_key_form check (manifest_key = 'bundle/' || hash || '/' || build || '/manifest'),
  constraint bundles_active_has_time check (not active or activated_at is not null)
);

-- At most one active bundle id.
create unique index bundles_one_active on bundles (active) where active;

create trigger bundles_version_raised
  before update on bundles
  for each row execute function enforce_version_raise();

-- PostgreSQL's copy of each bundle value, read on a KV miss. Written once at publish: no version.
create table bundle_values (
  key text primary key,
  bundle_hash text not null,
  bundle_build integer not null,
  kind text not null,
  bytes integer not null,
  sha256 text not null,
  value bytea not null,
  constraint bundle_values_bundle_fk foreign key (bundle_hash, bundle_build)
    references bundles (hash, build) on delete restrict,
  constraint bundle_values_kind_known check (kind in ('manifest', 'flow', 'trade')),
  constraint bundle_values_key_form check (
    key ~ '^bundle/[0-9a-f]{64}/[1-9][0-9]*/(manifest|flow/[AB]|trade/[a-z0-9][a-z0-9-]*)$'
  ),
  constraint bundle_values_key_of_bundle check (
    split_part(key, '/', 2) = bundle_hash
    and split_part(key, '/', 3) = bundle_build::text
    and split_part(key, '/', 4) = kind
  ),
  constraint bundle_values_bytes_range check (bytes between 1 and 26214400),
  constraint bundle_values_bytes_match check (octet_length(value) = bytes),
  constraint bundle_values_sha256_match check (sha256 = encode(sha256(value), 'hex'))
);

create index bundle_values_bundle_idx on bundle_values (bundle_hash, bundle_build);

-- Release flags (ADR-010 draft): set globally, or for one business or one phone.
create table release_flags (
  name text not null,
  scope text not null default 'global',
  enabled boolean not null default false,
  value jsonb,
  version integer not null default 1,
  primary key (name, scope),
  constraint release_flags_name_form check (name ~ '^[a-z][a-z0-9_.-]*$'),
  constraint release_flags_scope_form check (
    scope = 'global' or scope ~ '^business:.+$' or scope ~ '^phone:\+[1-9][0-9]{6,14}$'
  )
);

create trigger release_flags_version_raised
  before update on release_flags
  for each row execute function enforce_version_raise();
