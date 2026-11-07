-- T-182: per-person sealing keys (K-04 v1 core, frozen: contracts/db-schema/core; the last table of the list).
-- Table: sealing_keys. Expand only: one new table, one new trigger. Reuses enforce_version_raise() from 0002.
--
-- A person's private values are encrypted (sealed) under a data key of their own. The data key is stored here wrapped
-- under a key held in Workers secrets (NQ-DB-1 default: one environment key wraps every data key). This table names
-- that secret (wrapping_key_name) and never holds its value (rule 7). Erasing a person sets wrapped_key to null and
-- erased_at: the sealed values then cannot be read again by anyone (RULES 4.10), and the row stays as the record.
--
-- Row-level security: scope none. A person's key covers them at every business (FS line 743), so the table has no
-- business column and no policy; it is reached only from the unscoped runtime side.

create table sealing_keys (
  person_id text primary key,
  wrapped_key bytea,
  wrapping_key_name text not null,
  created_at timestamptz not null default now(),
  erased_at timestamptz,
  version integer not null default 1,
  constraint sealing_keys_person_fk foreign key (person_id) references persons (id) on delete restrict,
  -- A key is either held (wrapped bytes, never erased) or erased (no bytes, an erase time); never both or neither.
  constraint sealing_keys_erased_or_held check ((erased_at is null) = (wrapped_key is not null)),
  -- A name such as SEALING_WRAP_KEY: a Workers secret's name, never a value.
  constraint sealing_keys_name_form check (wrapping_key_name ~ '^[A-Z][A-Z0-9_]*$')
);

create trigger sealing_keys_version_raised
  before update on sealing_keys
  for each row execute function enforce_version_raise();
